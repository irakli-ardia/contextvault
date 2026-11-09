import { randomUUID } from "node:crypto";
import { loadWorkerEnv } from "@contextvault/config";
import { createIngestionHarness } from "@contextvault/db/testing/ingestion";
import type { StageInput, WorkspaceId } from "@contextvault/domain";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { processJobName } from "../../queue/bullmq-job-queue";
import { startRedisProxy } from "../../testing/redis-proxy-test-support";
import { testRedisUrl } from "../../testing/test-redis-url";
import { closeConsumer, connectConsumer } from "../consumer-connection";
import { IngestionShutdownIncomplete } from "../consumer-shutdown";
import { createIngestionConsumer, type IngestionConsumerOptions } from "../ingestion-consumer";
import { recordingStages } from "./ingestion-consumer-test-support";

// Real PostgreSQL (worker role) and real BullMQ on the isolated test stack, one queue per test.
// Waits are on events (a stage starting, a job settling), never on a guessed delay; the only
// timers are the shutdown bounds under test, set short.
// biome-ignore lint/style/noProcessEnv: launch flags set by the wrapper or the CI runner, not config
const flags = process.env;
const h = await createIngestionHarness();
const redisUrl = testRedisUrl(loadWorkerEnv().REDIS_URL, flags);
const { wsA } = h;
const bounds = { drainTimeoutMs: 300, cancelGraceMs: 300, releaseTimeoutMs: 500 };

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
const sockets = (): number =>
  process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap").length;
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const untilAborted = (input: StageInput) =>
  new Promise<void>((_resolve, reject) =>
    input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
  );
const outcome = (closing: Promise<void>) =>
  closing.then(
    () => "closed",
    (error: unknown) => error,
  );

let producer: Redis;
let queueName: string;
let inspect: Queue;
const consumers: { close(): Promise<void> }[] = [];

beforeAll(() => {
  producer = new Redis(redisUrl.toString(), { maxRetriesPerRequest: null });
  process.on("unhandledRejection", onUnhandled);
});
afterAll(async () => {
  process.off("unhandledRejection", onUnhandled);
  producer.disconnect();
  await h.close();
});
beforeEach(async () => {
  queueName = `cvtest-shutdown-${randomUUID()}`;
  inspect = new Queue(queueName, { connection: producer });
  await inspect.waitUntilReady();
});
afterEach(async () => {
  await Promise.all(consumers.splice(0).map((c) => c.close().catch(() => undefined)));
  await inspect.obliterate({ force: true });
  await inspect.close();
  expect(unhandled).toEqual([]);
});

const send = async (workspaceId: WorkspaceId, versionId: string): Promise<string> => {
  const jobId = `job-${randomUUID()}`;
  await inspect.add(
    processJobName,
    { workspaceId, versionId },
    { jobId, attempts: 1, removeOnComplete: false, removeOnFail: false },
  );
  return jobId;
};
const state = async (jobId: string) => (await inspect.getJob(jobId))?.getState();
const settled = async (jobId: string) => {
  await expect
    .poll(async () => ["completed", "failed"].includes((await state(jobId)) ?? ""), {
      timeout: 10_000,
    })
    .toBe(true);
  return state(jobId);
};
const start = async (
  over: Partial<IngestionConsumerOptions> & Pick<IngestionConsumerOptions, "stages">,
) => {
  const logs: Record<string, unknown>[] = [];
  const consumer = await createIngestionConsumer({
    redisUrl: redisUrl.toString(),
    uow: h.worker.unitOfWork,
    newId: randomUUID,
    queueName,
    redeliveryDelayMs: 100,
    ...bounds,
    log: (entry) => void logs.push(entry),
    ...over,
  });
  consumers.push(consumer);
  return { consumer, logs, codes: () => logs.map(({ code }) => code) };
};
/** A stage runner whose first stage reports that it started, then runs `behaviour`. */
const gated = (behaviour: (input: StageInput) => Promise<void>) => {
  const started = deferred();
  const run = recordingStages(async (input) => {
    started.resolve();
    await behaviour(input);
  });
  return { ...run, started: started.promise };
};

describe("BullMQ 6.5.1 close semantics the consumer relies on", () => {
  it("does not let close(true) interrupt a graceful close already waiting on a job", async () => {
    const release = deferred();
    const running = deferred();
    const conn = new Redis(redisUrl.toString(), { maxRetriesPerRequest: null });
    const worker = new Worker(
      queueName,
      async () => {
        running.resolve();
        await release.promise;
      },
      { connection: conn },
    );
    try {
      await worker.waitUntilReady();
      await inspect.add("x", {});
      await running.promise;
      const settled: string[] = [];
      const first = worker.close().then(() => settled.push("graceful"));
      const second = worker.close(true).then(() => settled.push("forced"));
      await expect.poll(() => worker.isRunning()).toBe(true);
      // Both are the same memoized promise: neither settles while the job runs.
      await Promise.race([first, second, new Promise((resolve) => setTimeout(resolve, 400))]);
      expect(settled).toEqual([]);
      release.resolve();
      await Promise.all([first, second]);
      expect(settled).toHaveLength(2);
    } finally {
      release.resolve();
      await worker.close(true);
      conn.disconnect();
    }
  });

  it("closes the consumer connection while Redis is down (QUIT settles on a reconnecting client)", async () => {
    const proxy = await startRedisProxy({ host: redisUrl.hostname, port: Number(redisUrl.port) });
    const via = new URL(redisUrl);
    via.host = `127.0.0.1:${proxy.port}`;
    const redis = await connectConsumer(via.toString());
    try {
      await proxy.setMode("down");
      await expect.poll(() => redis.status).toBe("reconnecting");
      const baseline = sockets();
      await closeConsumer(redis, 5_000);
      expect(redis.status).not.toBe("ready");
      expect(sockets()).toBeLessThanOrEqual(baseline);
    } finally {
      redis.disconnect();
      await proxy.close();
    }
  });
});

describe("ingestion consumer shutdown", () => {
  it("closes with no job in flight and releases every socket, however often it is called", async () => {
    const baseline = sockets();
    const t = await start({ stages: recordingStages().stages });
    const first = t.consumer.close();
    expect(t.consumer.close()).toBe(first);
    await first;
    await t.consumer.close();
    await expect.poll(sockets).toBeLessThanOrEqual(baseline);
    expect(t.codes()).toEqual([]);
  });

  it("lets a job finish inside the drain deadline and completes it normally", async () => {
    const id = await h.seed(wsA);
    const release = deferred();
    const run = gated(() => release.promise);
    const t = await start({ stages: run.stages, drainTimeoutMs: 10_000 });
    const job = await send(wsA, id);
    await run.started;
    const closing = outcome(t.consumer.close());
    release.resolve();
    expect(await closing).toBe("closed");
    expect(await state(job)).toBe("completed");
    expect(await h.row(id)).toMatchObject({ status: "processed", attempt: 1, lease_generation: 1 });
    expect(t.codes()).not.toContain("INGESTION_SHUTDOWN_CANCELLING");
  });

  it("cancels a cooperative job after the drain deadline and leaves its lease to recovery", async () => {
    const id = await h.seed(wsA);
    const run = gated(untilAborted);
    const t = await start({ stages: run.stages });
    const job = await send(wsA, id);
    await run.started;
    expect(await outcome(t.consumer.close())).toBe("closed");
    expect(await settled(job)).toBe("completed");
    expect(t.codes()).toContain("INGESTION_SHUTDOWN_CANCELLING");
    expect(t.codes()).not.toContain("INGESTION_LEASE_LOST");
    expect(t.logs).toContainEqual(
      expect.objectContaining({ outcome: "aborted", shutdownCancelled: true }),
    );
    // Claimed under generation 1 and not written since: the expiring lease is for 5B to find.
    expect(await h.row(id)).toMatchObject({ status: "parsing", attempt: 1, lease_generation: 1 });
  });

  it("reports a stage that ignores cancellation, frees the sockets and never lets it write", async () => {
    const baseline = sockets();
    const id = await h.seed(wsA);
    const release = deferred();
    const run = gated(() => release.promise);
    const t = await start({ stages: run.stages });
    await send(wsA, id);
    await run.started;
    const error = await outcome(t.consumer.close());
    expect(error).toBeInstanceOf(IngestionShutdownIncomplete);
    expect(error).toMatchObject({ abandonedJobs: 1 });
    expect(t.codes()).toContain("INGESTION_SHUTDOWN_INCOMPLETE");
    await expect.poll(sockets).toBeLessThanOrEqual(baseline);
    // The stage was never stopped; once it returns, the fenced writes stay untouched.
    release.resolve();
    await expect.poll(() => run.of(id).length).toBe(1);
    expect(await h.row(id)).toMatchObject({ status: "parsing", attempt: 1, lease_generation: 1 });
    expect(run.of(id)).toEqual([`${id}:parsing`]);
  });

  it("takes no job once close began, and a later consumer still processes it", async () => {
    const [first, second] = [await h.seed(wsA), await h.seed(wsA)];
    const release = deferred();
    const run = gated(() => release.promise);
    const t = await start({ stages: run.stages, concurrency: 1, drainTimeoutMs: 10_000 });
    const firstJob = await send(wsA, first);
    await run.started;
    const closing = outcome(t.consumer.close());
    const secondJob = await send(wsA, second);
    release.resolve();
    expect(await closing).toBe("closed");
    expect(await settled(firstJob)).toBe("completed");
    expect(await state(secondJob)).toBe("waiting");
    expect(await h.row(second)).toMatchObject({ status: "uploaded", attempt: 0 });

    const next = recordingStages();
    await start({ stages: next.stages });
    expect(await settled(secondJob)).toBe("completed");
    expect(await h.row(second)).toMatchObject({ status: "processed", attempt: 1 });
    expect(await h.row(first)).toMatchObject({ status: "processed", attempt: 1 });
  });

  it("leaves a job still running in another consumer alone", async () => {
    const [first, second] = [await h.seed(wsA), await h.seed(wsA)];
    const hold = deferred();
    const a = gated(() => hold.promise);
    const b = gated(() => hold.promise);
    const stopping = await start({ stages: a.stages, concurrency: 1 });
    const staying = await start({ stages: b.stages, concurrency: 1, drainTimeoutMs: 10_000 });
    await send(wsA, first);
    await send(wsA, second);
    await Promise.all([a.started, b.started]);
    const [stopped, kept] = [a.calls[0]?.split(":")[0] ?? "", b.calls[0]?.split(":")[0] ?? ""];
    const error = await outcome(stopping.consumer.close());
    expect(error).toBeInstanceOf(IngestionShutdownIncomplete);
    expect(staying.codes()).toEqual([]);
    hold.resolve();
    await expect.poll(async () => (await h.row(kept)).status).toBe("processed");
    // The abandoned job's stage returned too late to write: its row is as the claim left it.
    expect(await h.row(stopped)).toMatchObject({ status: "parsing", lease_generation: 1 });
    await staying.consumer.close();
  });

  it("bounds shutdown when Redis goes away mid-drain and raises no unhandled rejection", async () => {
    const proxy = await startRedisProxy({ host: redisUrl.hostname, port: Number(redisUrl.port) });
    const via = new URL(redisUrl);
    via.host = `127.0.0.1:${proxy.port}`;
    const id = await h.seed(wsA);
    const release = deferred();
    const run = gated(() => release.promise);
    try {
      const t = await start({
        stages: run.stages,
        redisUrl: via.toString(),
        drainTimeoutMs: 10_000,
      });
      await send(wsA, id);
      await run.started;
      const closing = outcome(t.consumer.close());
      await proxy.setMode("down");
      release.resolve();
      expect(await closing).toBe("closed");
      expect(t.codes()).toContain("INGESTION_SHUTDOWN_FORCED");
      await proxy.setMode("forward");
    } finally {
      release.resolve();
      await proxy.close();
    }
  });

  it("closes an idle consumer whose Redis is already down", async () => {
    const proxy = await startRedisProxy({ host: redisUrl.hostname, port: Number(redisUrl.port) });
    const via = new URL(redisUrl);
    via.host = `127.0.0.1:${proxy.port}`;
    const baseline = sockets();
    try {
      const t = await start({ stages: recordingStages().stages, redisUrl: via.toString() });
      await proxy.setMode("down");
      expect(await outcome(t.consumer.close())).toBe("closed");
      await expect.poll(sockets).toBeLessThanOrEqual(baseline);
    } finally {
      await proxy.close();
    }
  });
});
