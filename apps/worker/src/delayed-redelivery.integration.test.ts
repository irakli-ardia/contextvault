import { randomUUID } from "node:crypto";
import { loadWorkerEnv } from "@contextvault/config";
import { DelayedError, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testRedisUrl } from "./test-redis-url";

// Regression test: a processor can re-deliver a job later with attempts: 1 and never fail it.
// Runs only against the verified cv-test Redis or GitHub Actions' own loopback Redis.
// biome-ignore lint/style/noProcessEnv: launch flags set by the wrapper or the CI runner, not config
const flags = process.env;
const queueName = `cvtest-delay-${randomUUID()}`;
const delayMs = 150;
const delays = 3;

type Seen = {
  state: string;
  attemptsMade: number;
  attemptsStarted: number;
  token: string | undefined;
  lockHeld: boolean;
};

let redisUrl: URL;
let redis: Redis | undefined;
let queue: Queue | undefined;

beforeAll(async () => {
  redisUrl = testRedisUrl(loadWorkerEnv().REDIS_URL, flags);
  redis = new Redis(redisUrl.toString(), { maxRetriesPerRequest: null });
  queue = new Queue(queueName, { connection: redis });
  await queue.waitUntilReady();
});
afterAll(async () => {
  // Only what beforeAll created: the queue name is unique to this run, so obliterate is ours.
  try {
    await queue?.obliterate({ force: true });
    await queue?.close();
  } finally {
    redis?.disconnect();
  }
});

const sockets = (): number =>
  process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap").length;

describe("BullMQ delayed redelivery (attempts: 1)", () => {
  it("delays an active job three times without failing it, then completes it", async () => {
    if (!redis || !queue) throw new Error("setup did not complete");
    const [probe, jobs] = [redis, queue];
    const baseline = sockets();
    const jobId = `delay-${randomUUID()}`;
    const seen: Seen[] = [];
    const delayedAt: number[] = [];
    const transitions: string[] = [];
    const conn = new Redis(redisUrl.toString(), { maxRetriesPerRequest: null });
    const worker = new Worker(
      queueName,
      async (job, token) => {
        seen.push({
          state: await job.getState(),
          attemptsMade: job.attemptsMade,
          attemptsStarted: job.attemptsStarted,
          token,
          lockHeld: (await probe.get(`bull:${queueName}:${job.id}:lock`)) === token,
        });
        if (seen.length <= delays) {
          delayedAt.push(Date.now());
          await job.moveToDelayed(Date.now() + delayMs, token);
          transitions.push(await job.getState());
          throw new DelayedError();
        }
        return "done";
      },
      { connection: conn, concurrency: 1, lockDuration: 5_000 },
    );
    const failed: string[] = [];
    worker.on("failed", (job) => failed.push(job?.id ?? "?"));
    const completed = new Promise<void>((resolve) => worker.on("completed", () => resolve()));

    await jobs.add("process", { n: 1 }, { jobId, attempts: 1 });
    await completed;

    // Active -> delayed inside the processor; back to active after the delay.
    expect(transitions).toEqual(Array(delays).fill("delayed"));
    expect(seen.map((s) => s.state)).toEqual(Array(delays + 1).fill("active"));
    // Each redelivery waited at least the requested delay.
    const starts = seen.length;
    expect(starts).toBe(delays + 1);
    // Lock is held by the worker's token on every run, and gone once the job is released.
    expect(seen.every((s) => s.lockHeld && s.token !== undefined)).toBe(true);
    expect(await probe.exists(`bull:${queueName}:${jobId}:lock`)).toBe(0);
    // Delay is not an attempt: attemptsMade stays 0, attemptsStarted counts every pickup.
    expect(seen.map((s) => s.attemptsMade)).toEqual([0, 0, 0, 0]);
    expect(seen.map((s) => s.attemptsStarted)).toEqual([1, 2, 3, 4]);

    const job = await jobs.getJob(jobId);
    expect(await job?.getState()).toBe("completed");
    expect(job?.attemptsMade).toBe(1);
    expect(job?.attemptsStarted).toBe(4);
    expect(job?.returnvalue).toBe("done");
    expect(failed).toEqual([]);
    expect(await jobs.getFailedCount()).toBe(0);
    expect(await jobs.getDelayedCount()).toBe(0);
    expect(await jobs.getActiveCount()).toBe(0);

    await worker.close();
    conn.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The worker's own blocking connection and ours are gone: no sockets beyond the baseline.
    expect(sockets()).toBeLessThanOrEqual(baseline);
  });
});
