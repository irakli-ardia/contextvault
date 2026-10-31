import { randomUUID } from "node:crypto";
import { loadWorkerEnv } from "@contextvault/config";
import { createIngestionHarness } from "@contextvault/db/testing/ingestion";
import { dispatchOutbox, type IngestionUnitOfWork, parseOutboxId } from "@contextvault/domain";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobQueue, EnqueueTimeout } from "./bullmq-job-queue";
import { startDispatcherLoop } from "./dispatcher-loop";
import { connectProducer } from "./producer-connection";
import { startRedisProxy } from "./redis-proxy-test-support";

// Real PostgreSQL (worker role) and real BullMQ on the isolated test infrastructure. The
// dispatcher is narrowed to this file's workspaces; other files share the database.
const h = await createIngestionHarness();
const redisUrl = new URL(loadWorkerEnv().REDIS_URL);
const queueName = `cvtest-${randomUUID()}`;
const { wsA, wsB, worker } = h;

let proxy: Awaited<ReturnType<typeof startRedisProxy>>;
let producerRedis: Redis;
let jobQueue: ReturnType<typeof createJobQueue>;
let direct: Redis;
let inspect: Queue;

const deps = (over: { uow?: IngestionUnitOfWork } = {}) => ({
  source: h.ownSource,
  queue: jobQueue,
  uow: over.uow ?? worker.unitOfWork,
});
const outboxId = async (versionId: string) =>
  parseOutboxId((await h.outboxRows(versionId))[0]?.id ?? "");

beforeAll(async () => {
  proxy = await startRedisProxy({ host: redisUrl.hostname, port: Number(redisUrl.port) });
  const viaProxy = new URL(redisUrl);
  viaProxy.host = `127.0.0.1:${proxy.port}`;
  producerRedis = await connectProducer(viaProxy.toString());
  jobQueue = createJobQueue({ connection: producerRedis, queueName, enqueueTimeoutMs: 400 });
  direct = new Redis(redisUrl.toString(), { maxRetriesPerRequest: null });
  inspect = new Queue(queueName, { connection: direct });
  // Readiness, not timeout behaviour: the 400 ms budget above is for the tests that assert it, and a
  // cold first add under parallel suites can exceed it.
  const warmup = createJobQueue({ connection: producerRedis, queueName, enqueueTimeoutMs: 15_000 });
  try {
    await warmup.enqueue({
      jobId: `warmup-${randomUUID()}`,
      workspaceId: wsA,
      versionId: await h.seed(wsA),
    });
  } finally {
    await warmup.close();
  }
});
afterAll(async () => {
  await h.drainOutbox();
  await jobQueue.close();
  producerRedis.disconnect();
  await inspect.obliterate({ force: true });
  await inspect.close();
  direct.disconnect();
  await proxy.close();
  await h.close();
});

describe("outbox dispatch over BullMQ", () => {
  it("enqueues, then marks the entry and moves the version to queued", async () => {
    await h.drainOutbox();
    const id = await h.seed(wsA);
    expect(await dispatchOutbox(deps(), 50)).toMatchObject({ dispatched: 1, failures: [] });
    const job = await inspect.getJob(`outbox-${await outboxId(id)}`);
    expect(job?.data).toEqual({ workspaceId: wsA, versionId: id });
    expect((await h.outboxRows(id))[0]?.dispatched_at).not.toBeNull();
    expect((await h.row(id)).status).toBe("queued");
  });

  it("changes nothing while Redis is down, then dispatches once it is back", async () => {
    await h.drainOutbox();
    const id = await h.seed(wsA);
    const before = await h.outboxRows(id);
    await proxy.setMode("down");
    const down = await dispatchOutbox(deps(), 50);
    expect(down).toMatchObject({ dispatched: 0 });
    expect(down.failures).toHaveLength(1);
    expect(await h.outboxRows(id)).toEqual(before);
    expect((await h.row(id)).status).toBe("uploaded");

    await proxy.setMode("forward");
    await expect
      .poll(async () => (await dispatchOutbox(deps(), 50)).dispatched, { timeout: 10_000 })
      .toBe(1);
    expect((await h.row(id)).status).toBe("queued");
  });

  it("leaves the entry alone when Redis took the job but the acknowledgement was lost", async () => {
    await h.drainOutbox();
    const id = await h.seed(wsA);
    const before = await h.outboxRows(id);
    await proxy.setMode("drop-replies");
    const lost = await dispatchOutbox(deps(), 50);
    expect(lost.failures[0]?.error).toBeInstanceOf(EnqueueTimeout);
    expect(await h.outboxRows(id)).toEqual(before);
    const jobId = `outbox-${await outboxId(id)}`;
    await expect.poll(async () => (await inspect.getJob(jobId))?.id).toBe(jobId);

    await proxy.setMode("forward");
    await expect
      .poll(async () => (await dispatchOutbox(deps(), 50)).dispatched, { timeout: 10_000 })
      .toBe(1);
    expect((await inspect.getJobs(["waiting"])).filter((j) => j.id === jobId)).toHaveLength(1);
  });

  it("retries a failure between enqueue and mark under the same job id, also after the job finished", async () => {
    await h.drainOutbox();
    const id = await h.seed(wsA);
    const jobId = `outbox-${await outboxId(id)}`;
    const failing: IngestionUnitOfWork = {
      run: () => Promise.reject(new Error("connection lost")),
    };
    const first = await dispatchOutbox(deps({ uow: failing }), 50);
    expect(first.failures).toHaveLength(1);
    expect((await h.outboxRows(id))[0]?.dispatched_at).toBeNull();
    expect((await h.row(id)).status).toBe("uploaded");

    // A real BullMQ worker finishes the job: its id is retained, so a re-add stays a no-op.
    const consumer = new Worker(queueName, async () => undefined, {
      connection: direct.duplicate(),
    });
    await expect
      .poll(async () => (await inspect.getJob(jobId))?.isCompleted(), { timeout: 10_000 })
      .toBe(true);
    await consumer.close();

    expect(await dispatchOutbox(deps(), 50)).toMatchObject({ dispatched: 1, failures: [] });
    expect(
      (await inspect.getJobs(["waiting", "active", "delayed"])).filter((j) => j.id === jobId),
    ).toHaveLength(0);
    expect((await h.row(id)).status).toBe("queued");
  });

  it("lets concurrent dispatchers transition each entry exactly once", async () => {
    await h.drainOutbox();
    const ids = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => h.seed(n % 2 ? wsA : wsB)));
    const runs = await Promise.all([1, 2, 3].map(() => dispatchOutbox(deps(), 50)));
    expect(runs.flatMap((r) => r.failures)).toEqual([]);
    expect(runs.reduce((sum, r) => sum + r.dispatched, 0)).toBe(ids.length);
    for (const id of ids) expect((await h.row(id)).status).toBe("queued");
  });

  it("does not enqueue a retry entry before its backoff is due", async () => {
    await h.drainOutbox();
    const id = await h.seed(wsA, { outboxDelayMs: 60_000, status: "queued", attempt: 1 });
    expect(await dispatchOutbox(deps(), 50)).toMatchObject({ dispatched: 0, failures: [] });
    await h.makeDue(id);
    expect(await dispatchOutbox(deps(), 50)).toMatchObject({ dispatched: 1 });
  });

  it("shuts down cleanly: stop waits for the scan in flight, then nothing is left running", async () => {
    await h.drainOutbox();
    const id = await h.seed(wsA);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow = {
      enqueue: async (job: Parameters<typeof jobQueue.enqueue>[0]) => {
        entered?.();
        await gate;
        await jobQueue.enqueue(job);
      },
    };
    const loop = startDispatcherLoop({
      scan: (after) => dispatchOutbox({ ...deps(), queue: slow }, 50, after),
      pollMs: 50,
      maxBackoffMs: 100,
      log: () => undefined,
    });
    await started;
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    // The scan that was in flight completed its mark, and no later scan ran.
    expect((await h.row(id)).status).toBe("queued");
    const marked = (await h.outboxRows(id))[0]?.dispatched_at;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await h.outboxRows(id))[0]?.dispatched_at).toEqual(marked);
  });
});
