import { randomUUID } from "node:crypto";
import { loadWorkerEnv } from "@contextvault/config";
import { createIngestionHarness } from "@contextvault/db/testing/ingestion";
import type { IngestionUnitOfWork, StageInput } from "@contextvault/domain";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processJobName } from "./bullmq-job-queue";
import { createIngestionConsumer, type IngestionConsumerOptions } from "./ingestion-consumer";
import { type Fault, faultyUow, recordingStages } from "./ingestion-consumer-test-support";
import { testRedisUrl } from "./test-redis-url";

// Real PostgreSQL (worker role) and real BullMQ on the isolated test stack. The lease is the
// row's `updated_at` on the database clock, so a stale one is made by backdating it.
// biome-ignore lint/style/noProcessEnv: launch flags set by the wrapper or the CI runner, not config
const flags = process.env;
const h = await createIngestionHarness();
const redisUrl = testRedisUrl(loadWorkerEnv().REDIS_URL, flags);
const queueName = `cvtest-heartbeat-${randomUUID()}`;
const { wsA } = h;

let producer: Redis;
let inspect: Queue;
const sockets = (): number =>
  process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap").length;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);

beforeAll(async () => {
  process.on("unhandledRejection", onUnhandled);
  producer = new Redis(redisUrl.toString(), { maxRetriesPerRequest: null });
  inspect = new Queue(queueName, { connection: producer });
  await inspect.waitUntilReady();
});
afterAll(async () => {
  process.off("unhandledRejection", onUnhandled);
  await inspect.obliterate({ force: true });
  await inspect.close();
  producer.disconnect();
  await h.close();
});

const send = async (versionId: string): Promise<string> => {
  const jobId = `job-${randomUUID()}`;
  await inspect.add(
    processJobName,
    { workspaceId: wsA, versionId },
    { jobId, attempts: 1, removeOnComplete: false, removeOnFail: false },
  );
  return jobId;
};
const state = async (jobId: string) => (await inspect.getJob(jobId))?.getState();
const completed = (jobId: string) =>
  expect.poll(() => state(jobId), { timeout: 10_000 }).toBe("completed");
const ageSeconds = async (id: string): Promise<number> => {
  const { rows } = await h.fx.fixture.query<{ age: number }>(
    "select extract(epoch from now() - updated_at)::float8 as age from document_versions where id = $1",
    [id],
  );
  return rows[0]?.age ?? Number.NaN;
};
const takeOver = (id: string) =>
  h.fx.fixture.query("update document_versions set lease_generation = 9 where id = $1", [id]);

const logs: Record<string, unknown>[] = [];
const codes = (code: string) => logs.filter(({ code: logged }) => logged === code).length;
const consumers: { close(): Promise<void> }[] = [];
const start = async (
  over: Partial<IngestionConsumerOptions> & Pick<IngestionConsumerOptions, "stages">,
) => {
  logs.length = 0;
  consumers.push(
    await createIngestionConsumer({
      redisUrl: redisUrl.toString(),
      uow: h.worker.unitOfWork,
      newId: randomUUID,
      queueName,
      heartbeatIntervalMs: 40,
      heartbeatTimeoutMs: 150,
      log: (entry) => void logs.push(entry),
      ...over,
    }),
  );
};
const stopAll = async () => {
  await Promise.all(consumers.splice(0).map((c) => c.close()));
};
// Observable, not slept: the signal is advisory, so a stage ignoring it can still watch it.
const waitAborted = (input: StageInput) =>
  expect.poll(() => input.signal.aborted, { timeout: 10_000 }).toBe(true);
const respectsAbort = (input: StageInput) =>
  new Promise<void>((_resolve, reject) =>
    input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
  );

describe("ingestion consumer with the lease heartbeat", () => {
  it("renews the lease of a running stage, completes, and leaks no socket or rejection", async () => {
    const id = await h.seed(wsA);
    await h.run(wsA, (repo) => repo.findVersion(id));
    const baseline = sockets();
    const run = recordingStages(async (input) => {
      if (input.stage !== "parsing") return;
      await h.fx.fixture.query(
        "update document_versions set updated_at = now() - interval '10 minutes' where id = $1",
        [id],
      );
      await expect.poll(() => ageSeconds(id), { timeout: 10_000 }).toBeLessThan(60);
    });
    await start({ stages: run.stages });
    await completed(await send(id));
    expect(await h.row(id)).toMatchObject({ status: "processed", attempt: 1, lease_generation: 1 });
    expect(codes("INGESTION_LEASE_LOST")).toBe(0);
    await stopAll();
    await pause(100);
    expect(sockets()).toBeLessThanOrEqual(baseline);
    expect(unhandled).toEqual([]);
  });

  it("cancels only the job that lost its lease, which writes nothing afterwards", async () => {
    const lost = await h.seed(wsA);
    const kept = await h.seed(wsA);
    let lostSignal: StageInput["signal"] | undefined;
    const run = recordingStages(async (input) => {
      if (input.versionId === lost) {
        lostSignal = input.signal;
        await takeOver(lost);
        return respectsAbort(input);
      }
      // Overlaps the other job and finishes only after that job was cancelled.
      await expect.poll(() => lostSignal?.aborted, { timeout: 10_000 }).toBe(true);
      expect(input.signal.aborted).toBe(false);
    });
    await start({ stages: run.stages });
    const jobs = [await send(lost), await send(kept)];
    for (const job of jobs) await completed(job);
    expect(run.of(lost)).toEqual([`${lost}:parsing`]);
    expect(await h.row(lost)).toMatchObject({ status: "parsing", lease_generation: 9, attempt: 1 });
    expect(await h.row(kept)).toMatchObject({ status: "processed", lease_generation: 1 });
    expect(codes("INGESTION_LEASE_LOST")).toBe(1);
    await stopAll();
  });

  it("writes nothing when a stage ignores the cancellation and returns later", async () => {
    const id = await h.seed(wsA);
    const run = recordingStages(async (input) => {
      await takeOver(id);
      await waitAborted(input);
      await pause(100);
    });
    await start({ stages: run.stages });
    await completed(await send(id));
    expect(run.of(id)).toEqual([`${id}:parsing`]);
    expect(await h.row(id)).toMatchObject({ status: "parsing", lease_generation: 9, attempt: 1 });
    expect(codes("INGESTION_LEASE_LOST")).toBe(1);
    await stopAll();
  });

  it("does not take an unknown or transient heartbeat outcome for lost ownership", async () => {
    const id = await h.seed(wsA);
    // Call 1 is the claim; the first beats fail, one of them after its renewal really committed.
    const faults: Record<number, Fault> = { 2: "ambiguous-after-commit", 3: "transient" };
    const { uow } = faultyUow(h.worker.unitOfWork, (call) => faults[call]);
    const run = recordingStages(async (input) => {
      if (input.stage !== "parsing") return;
      await expect.poll(() => codes("INGESTION_HEARTBEAT_RECOVERED"), { timeout: 10_000 }).toBe(1);
    });
    await start({ stages: run.stages, uow });
    await completed(await send(id));
    expect(await h.row(id)).toMatchObject({ status: "processed", attempt: 1, lease_generation: 1 });
    expect(codes("INGESTION_LEASE_LOST")).toBe(0);
    expect(codes("INGESTION_HEARTBEAT_FAILED")).toBe(1);
    expect(JSON.stringify(logs)).not.toContain("secret-host");
    await stopAll();
  });

  it("finishes the job while a heartbeat never settles, and ignores its late answer", async () => {
    const id = await h.seed(wsA);
    let release: () => void = () => undefined;
    let hung = false;
    const real = h.worker.unitOfWork;
    // The second call is the first beat of the first stage: it does not run until released.
    let calls = 0;
    const uow: IngestionUnitOfWork = {
      run: (context, work, options) => {
        calls += 1;
        if (calls !== 2) return real.run(context, work, options);
        hung = true;
        return new Promise((resolve) => {
          release = () => resolve(real.run(context, work, options));
        });
      },
    };
    const run = recordingStages(async (input) => {
      if (input.stage === "parsing") await expect.poll(() => hung, { timeout: 10_000 }).toBe(true);
    });
    await start({ stages: run.stages, uow });
    await completed(await send(id));
    expect(await h.row(id)).toMatchObject({ status: "processed", attempt: 1, lease_generation: 1 });
    // Its answer finally arrives, and says the lease is lost: too late to decide anything.
    await takeOver(id);
    release();
    await pause(100);
    expect(codes("INGESTION_LEASE_LOST")).toBe(0);
    expect(unhandled).toEqual([]);
    await stopAll();
  });
});
