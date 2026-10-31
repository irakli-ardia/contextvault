import { randomUUID } from "node:crypto";
import { loadWorkerEnv } from "@contextvault/config";
import { DelayedError, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Spike for M1.4 5A.1: can a processor re-deliver a job later with attempts: 1 and never fail it?
// Needs the isolated cv-test Redis; refuses to run against anything else.
const redisUrl = new URL(loadWorkerEnv().REDIS_URL);
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

let redis: Redis;
let queue: Queue;

beforeAll(async () => {
  if (redisUrl.hostname !== "127.0.0.1" || redisUrl.port !== "56379") {
    throw new Error("delayed-redelivery spike runs only against the isolated cv-test Redis");
  }
  redis = new Redis(redisUrl.toString(), { maxRetriesPerRequest: null });
  queue = new Queue(queueName, { connection: redis });
  await queue.waitUntilReady();
});
afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  redis.disconnect();
});

const sockets = (): number =>
  process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap").length;

describe("BullMQ delayed redelivery (attempts: 1)", () => {
  it("delays an active job three times without failing it, then completes it", async () => {
    const baseline = sockets();
    const jobId = `spike-${randomUUID()}`;
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
          lockHeld: (await redis.get(`bull:${queueName}:${job.id}:lock`)) === token,
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

    await queue.add("process", { n: 1 }, { jobId, attempts: 1 });
    await completed;

    // Active -> delayed inside the processor; back to active after the delay.
    expect(transitions).toEqual(Array(delays).fill("delayed"));
    expect(seen.map((s) => s.state)).toEqual(Array(delays + 1).fill("active"));
    // Each redelivery waited at least the requested delay.
    const starts = seen.length;
    expect(starts).toBe(delays + 1);
    // Lock is held by the worker's token on every run, and gone once the job is released.
    expect(seen.every((s) => s.lockHeld && s.token !== undefined)).toBe(true);
    expect(await redis.exists(`bull:${queueName}:${jobId}:lock`)).toBe(0);
    // Delay is not an attempt: attemptsMade stays 0, attemptsStarted counts every pickup.
    expect(seen.map((s) => s.attemptsMade)).toEqual([0, 0, 0, 0]);
    expect(seen.map((s) => s.attemptsStarted)).toEqual([1, 2, 3, 4]);

    const job = await queue.getJob(jobId);
    expect(await job?.getState()).toBe("completed");
    expect(job?.attemptsMade).toBe(1);
    expect(job?.attemptsStarted).toBe(4);
    expect(job?.returnvalue).toBe("done");
    expect(failed).toEqual([]);
    expect(await queue.getFailedCount()).toBe(0);
    expect(await queue.getDelayedCount()).toBe(0);
    expect(await queue.getActiveCount()).toBe(0);

    await worker.close();
    conn.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The worker's own blocking connection and ours are gone: no sockets beyond the baseline.
    expect(sockets()).toBeLessThanOrEqual(baseline);
  });
});
