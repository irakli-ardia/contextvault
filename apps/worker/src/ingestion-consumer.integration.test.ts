import { randomUUID } from "node:crypto";
import { loadWorkerEnv } from "@contextvault/config";
import { createIngestionHarness } from "@contextvault/db/testing/ingestion";
import { dispatchOutbox, type VersionStatus, type WorkspaceId } from "@contextvault/domain";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobQueue, processJobName } from "./bullmq-job-queue";
import { createIngestionConsumer, type IngestionConsumerOptions } from "./ingestion-consumer";
import {
  type Fault,
  failStage,
  faultyUow,
  recordingStages,
} from "./ingestion-consumer-test-support";
import { startRedisProxy } from "./redis-proxy-test-support";
import { testRedisUrl } from "./test-redis-url";

// Real PostgreSQL (worker role) and real BullMQ on the isolated test stack, one queue per run.
// biome-ignore lint/style/noProcessEnv: launch flags set by the wrapper or the CI runner, not config
const flags = process.env;
const h = await createIngestionHarness();
const redisUrl = testRedisUrl(loadWorkerEnv().REDIS_URL, flags);
const queueName = `cvtest-consumer-${randomUUID()}`;
const { wsA, wsB } = h;

let producer: Redis;
let jobQueue: ReturnType<typeof createJobQueue>;
let inspect: Queue;
const sockets = (): number =>
  process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap").length;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  producer = new Redis(redisUrl.toString(), { maxRetriesPerRequest: null });
  jobQueue = createJobQueue({ connection: producer, queueName, enqueueTimeoutMs: 15_000 });
  inspect = new Queue(queueName, { connection: producer });
  await inspect.waitUntilReady();
});
afterAll(async () => {
  await jobQueue.close();
  await inspect.obliterate({ force: true });
  await inspect.close();
  producer.disconnect();
  await h.close();
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
const failedReason = async (jobId: string) => (await inspect.getJob(jobId))?.failedReason;

const consumers: { close(): Promise<void> }[] = [];
const start = async (
  over: Partial<IngestionConsumerOptions> & Pick<IngestionConsumerOptions, "stages">,
) => {
  const consumer = await createIngestionConsumer({
    redisUrl: redisUrl.toString(),
    uow: h.worker.unitOfWork,
    newId: randomUUID,
    queueName,
    redeliveryDelayMs: 100,
    log: () => undefined,
    ...over,
  });
  consumers.push(consumer);
  return consumer;
};
const stopAll = async () => {
  await Promise.all(consumers.splice(0).map((c) => c.close()));
};

describe("ingestion consumer", () => {
  it("processes a job that is visible before its outbox entry is marked, and releases everything", async () => {
    const id = await h.seed(wsA);
    // The pool's first connection is not the consumer's: open it before counting.
    await h.run(wsA, (repo) => repo.findVersion(id));
    const baseline = sockets();
    const run = recordingStages();
    await start({ stages: run.stages });
    // No dispatcher ran: the job exists, the entry is live and the version is still `uploaded`.
    expect(await settled(await send(wsA, id))).toBe("completed");
    expect(run.of(id)).toEqual([`${id}:parsing`, `${id}:chunking`]);
    expect(await h.row(id)).toMatchObject({ status: "processed", attempt: 1, lease_generation: 1 });
    expect((await h.outboxRows(id))[0]?.dispatched_at).not.toBeNull();
    // The dispatcher arriving late finds nothing left to mark.
    expect(
      await dispatchOutbox({ source: h.ownSource, queue: jobQueue, uow: h.worker.unitOfWork }, 50),
    ).toMatchObject({ failures: [] });
    expect((await h.row(id)).status).toBe("processed");

    await stopAll();
    await pause(100);
    expect(sockets()).toBeLessThanOrEqual(baseline);
  });

  it("fails an invalid payload or foreign job name and touches nothing", async () => {
    const run = recordingStages();
    await start({ stages: run.stages });
    const bad = await inspect.add(processJobName, { workspaceId: wsA }, { attempts: 1 });
    const foreign = await inspect.add(
      "other",
      { workspaceId: wsA, versionId: randomUUID() },
      { attempts: 1 },
    );
    for (const job of [bad, foreign]) {
      expect(await settled(job.id ?? "")).toBe("failed");
      expect(await failedReason(job.id ?? "")).toBe("job.invalid_payload");
    }
    expect(run.calls).toEqual([]);
    await stopAll();
  });

  it("runs each version once under duplicate deliveries and competing consumers", async () => {
    const ids = await Promise.all([1, 2, 3, 4].map(() => h.seed(wsA)));
    const run = recordingStages(() => pause(30));
    await start({ stages: run.stages, concurrency: 2 });
    await start({ stages: run.stages, concurrency: 2 });
    const jobs = await Promise.all(
      ids.flatMap((id) => [send(wsA, id), send(wsA, id), send(wsA, id)]),
    );
    for (const job of jobs) expect(await settled(job)).toBe("completed");
    for (const id of ids) {
      expect(run.of(id)).toEqual([`${id}:parsing`, `${id}:chunking`]);
      expect(await h.row(id)).toMatchObject({
        status: "processed",
        attempt: 1,
        lease_generation: 1,
      });
    }
    await stopAll();
  });

  it("refuses a version of another workspace", async () => {
    const id = await h.seed(wsA);
    const run = recordingStages();
    await start({ stages: run.stages });
    expect(await settled(await send(wsB, id))).toBe("completed");
    expect(run.calls).toEqual([]);
    expect(await h.row(id)).toMatchObject({ status: "uploaded", attempt: 0, lease_generation: 0 });
    await stopAll();
  });

  it.each<[string, VersionStatus, number]>([
    ["processed", "processed", 1],
    ["failed", "failed", 1],
    ["running elsewhere", "parsing", 1],
    ["attempts spent", "queued", 3],
  ])(
    "completes a refused claim for a version that is %s, consuming no attempt",
    async (_n, status, attempt) => {
      const id = await h.seed(wsA, { status, attempt });
      const run = recordingStages();
      await start({ stages: run.stages });
      expect(await settled(await send(wsA, id))).toBe("completed");
      expect(run.calls).toEqual([]);
      expect(await h.row(id)).toMatchObject({ status, attempt, lease_generation: 0 });
      await stopAll();
    },
  );

  it("does not delay or run a job whose retry PostgreSQL has scheduled", async () => {
    const id = await h.seed(wsA, { status: "queued", attempt: 1, outboxDelayMs: 60_000 });
    const run = recordingStages();
    await start({ stages: run.stages });
    const job = await send(wsA, id);
    expect(await settled(job)).toBe("completed");
    expect((await inspect.getJob(job))?.attemptsStarted).toBe(1);
    expect(run.calls).toEqual([]);
    expect(await h.row(id)).toMatchObject({ status: "queued", attempt: 1 });
    await stopAll();
  });

  it("redelivers a transient failure before the claim repeatedly without using a PostgreSQL attempt", async () => {
    const id = await h.seed(wsA);
    const { uow } = faultyUow(h.worker.unitOfWork, (call) => (call <= 3 ? "transient" : undefined));
    const run = recordingStages();
    await start({ stages: run.stages, uow });
    const job = await send(wsA, id);
    expect(await settled(job)).toBe("completed");
    const finished = await inspect.getJob(job);
    expect(finished?.attemptsStarted).toBe(4);
    expect(run.of(id)).toHaveLength(2);
    expect(await h.row(id)).toMatchObject({ status: "processed", attempt: 1, lease_generation: 1 });
    await stopAll();
  });

  it("fails a permanent database error without leaking it or touching the version", async () => {
    const id = await h.seed(wsA);
    const { uow } = faultyUow(h.worker.unitOfWork, () => "permanent");
    const run = recordingStages();
    await start({ stages: run.stages, uow });
    const job = await send(wsA, id);
    expect(await settled(job)).toBe("failed");
    expect(await failedReason(job)).toBe("db.permanent_error");
    expect(run.calls).toEqual([]);
    expect(await h.row(id)).toMatchObject({ status: "uploaded", attempt: 0 });
    await stopAll();
  });

  it("fails an ambiguous claim without delaying, running stages or reporting success", async () => {
    const id = await h.seed(wsA);
    const plan = (call: number): Fault | undefined =>
      call === 1 ? "ambiguous-after-commit" : undefined;
    const { uow, calls } = faultyUow(h.worker.unitOfWork, plan);
    const run = recordingStages();
    await start({ stages: run.stages, uow });
    const job = await send(wsA, id);
    expect(await settled(job)).toBe("failed");
    expect(await failedReason(job)).toBe("claim.outcome_unknown");
    expect((await inspect.getJob(job))?.attemptsStarted).toBe(1);
    expect(run.calls).toEqual([]);
    expect(calls()).toBe(1);
    // The claim did land: left to lease recovery, never to a guess.
    expect(await h.row(id)).toMatchObject({ status: "parsing", attempt: 1 });
    await stopAll();
  });

  it("completes the job when the version fails permanently, and when a retry is scheduled", async () => {
    const dead = await h.seed(wsA);
    const retry = await h.seed(wsA);
    const run = recordingStages((input) => {
      if (input.versionId === dead) return failStage("parsing", "parse.corrupt", false)(input);
      return failStage("chunking", "storage.unavailable", true)(input);
    });
    await start({ stages: run.stages });
    expect(await settled(await send(wsA, dead))).toBe("completed");
    expect(await h.row(dead)).toMatchObject({
      status: "failed",
      error_code: "parse.corrupt",
      attempt: 1,
    });

    const retryJob = await send(wsA, retry);
    expect(await settled(retryJob)).toBe("completed");
    expect(await h.row(retry)).toMatchObject({ status: "queued", attempt: 1 });
    const entries = await h.outboxRows(retry);
    expect(entries.filter((e) => e.dispatched_at === null)).toHaveLength(1);
    // An early redelivery is refused: it does not skip the backoff or spend an attempt.
    expect(await settled(await send(wsA, retry))).toBe("completed");
    expect(await h.row(retry)).toMatchObject({ status: "queued", attempt: 1 });
    expect(run.of(retry)).toHaveLength(2);
    await stopAll();
  });

  it("completes the job without touching the version when ownership moved on", async () => {
    const id = await h.seed(wsA);
    const run = recordingStages(async () => {
      await h.fx.fixture.query("update document_versions set lease_generation = 9 where id = $1", [
        id,
      ]);
    });
    await start({ stages: run.stages });
    expect(await settled(await send(wsA, id))).toBe("completed");
    expect(run.of(id)).toEqual([`${id}:parsing`]);
    expect(await h.row(id)).toMatchObject({ status: "parsing", lease_generation: 9, attempt: 1 });
    await stopAll();
  });
});

describe("ingestion consumer startup and Redis", () => {
  it("rejects when Redis is unreachable and leaves no socket behind", async () => {
    const baseline = sockets();
    await expect(
      createIngestionConsumer({
        redisUrl: "redis://127.0.0.1:1",
        uow: h.worker.unitOfWork,
        stages: recordingStages().stages,
        newId: randomUUID,
        log: () => undefined,
      }),
    ).rejects.toThrow();
    await pause(100);
    expect(sockets()).toBeLessThanOrEqual(baseline);
  });

  it("closes the connection it opened when the worker cannot be created", async () => {
    const baseline = sockets();
    await expect(
      createIngestionConsumer({
        redisUrl: redisUrl.toString(),
        uow: h.worker.unitOfWork,
        stages: recordingStages().stages,
        newId: randomUUID,
        log: () => undefined,
        queueName: "invalid:name",
      }),
    ).rejects.toThrow();
    await pause(100);
    expect(sockets()).toBeLessThanOrEqual(baseline);
  });

  it("survives a Redis outage and processes the next job after it", async () => {
    const target = { host: redisUrl.hostname, port: Number(redisUrl.port) };
    const proxy = await startRedisProxy(target);
    const via = new URL(redisUrl);
    via.host = `127.0.0.1:${proxy.port}`;
    const logs: Record<string, unknown>[] = [];
    const run = recordingStages();
    try {
      await start({ stages: run.stages, redisUrl: via.toString(), log: (e) => void logs.push(e) });
      await proxy.setMode("down");
      await pause(500);
      await proxy.setMode("forward");
      const id = await h.seed(wsA);
      expect(await settled(await send(wsA, id))).toBe("completed");
      expect(await h.row(id)).toMatchObject({ status: "processed", attempt: 1 });
      expect(JSON.stringify(logs)).not.toContain(redisUrl.password || "\u0000");
    } finally {
      await stopAll();
      await proxy.close();
    }
  });
});
