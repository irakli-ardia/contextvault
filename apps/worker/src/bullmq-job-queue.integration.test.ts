import { randomUUID } from "node:crypto";
import { loadWorkerEnv } from "@contextvault/config";
import { parseDocumentVersionId, parseWorkspaceId } from "@contextvault/domain";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobQueue, EnqueueTimeout, processJobName } from "./bullmq-job-queue";
import { closeProducer, connectProducer } from "./producer-connection";
import { type startRedisProxy as StartProxy, startRedisProxy } from "./redis-proxy-test-support";

// Real Redis through a proxy that can cut it off or swallow its replies. Needs the isolated
// test Redis (REDIS_URL); the queue name is unique to this file.
const redisUrl = new URL(loadWorkerEnv().REDIS_URL);
const queueName = `cvtest-${randomUUID()}`;
const job = () => ({
  jobId: `outbox-${randomUUID()}`,
  workspaceId: parseWorkspaceId(randomUUID()),
  versionId: parseDocumentVersionId(randomUUID()),
});

let proxy: Awaited<ReturnType<typeof StartProxy>>;
let direct: Redis;
let inspect: Queue;

const producer = async (enqueueTimeoutMs = 500) => {
  const url = new URL(redisUrl);
  url.host = `127.0.0.1:${proxy.port}`;
  const connection = await connectProducer(url.toString());
  const queue = createJobQueue({ connection, queueName, enqueueTimeoutMs });
  return {
    queue,
    close: async () => {
      await queue.close();
      connection.disconnect();
    },
  };
};

beforeAll(async () => {
  proxy = await startRedisProxy({ host: redisUrl.hostname, port: Number(redisUrl.port) });
  direct = new Redis(redisUrl.toString(), { maxRetriesPerRequest: null });
  inspect = new Queue(queueName, { connection: direct });
});
afterAll(async () => {
  await inspect.obliterate({ force: true });
  await inspect.close();
  direct.disconnect();
  await proxy.close();
});

describe("createJobQueue", () => {
  it("adds one `process` job with ids only, one attempt and bounded retention", async () => {
    const p = await producer();
    const j = job();
    await p.queue.enqueue(j);
    const stored = await inspect.getJob(j.jobId);
    expect(stored?.name).toBe(processJobName);
    expect(stored?.data).toEqual({ workspaceId: j.workspaceId, versionId: j.versionId });
    expect(stored?.opts).toMatchObject({
      attempts: 1,
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
    });
    await p.close();
  });

  it("answers a repeated job id with the job already held, not an error or a second job", async () => {
    const p = await producer();
    const j = job();
    const before = await inspect.getJobCountByTypes("waiting");
    await p.queue.enqueue(j);
    await p.queue.enqueue(j);
    expect(await inspect.getJobCountByTypes("waiting")).toBe(before + 1);
    await p.close();
  });

  it("fails fast while Redis is down and adds again once it is back", async () => {
    const p = await producer(5_000);
    await p.queue.enqueue(job());
    await proxy.setMode("down");
    const started = Date.now();
    await expect(p.queue.enqueue(job())).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);

    await proxy.setMode("forward");
    const j = job();
    await expect
      .poll(
        () =>
          p.queue.enqueue(j).then(
            () => true,
            () => false,
          ),
        {
          timeout: 10_000,
        },
      )
      .toBe(true);
    expect((await inspect.getJob(j.jobId))?.id).toBe(j.jobId);
    await p.close();
  });

  it("times out when the acknowledgement is lost, though Redis kept the job", async () => {
    const p = await producer(300);
    await p.queue.enqueue(job()); // lets BullMQ finish its own start-up commands first
    await proxy.setMode("drop-replies");
    const j = job();
    await expect(p.queue.enqueue(j)).rejects.toBeInstanceOf(EnqueueTimeout);
    // Ambiguous: the timeout says nothing about whether Redis accepted the add.
    await expect.poll(async () => (await inspect.getJob(j.jobId))?.id).toBe(j.jobId);

    await proxy.setMode("forward");
    await expect
      .poll(
        () =>
          p.queue.enqueue(j).then(
            () => true,
            () => false,
          ),
        {
          timeout: 10_000,
        },
      )
      .toBe(true);
    expect(await inspect.getJobCountByTypes("waiting")).toBeGreaterThan(0);
    const same = (await inspect.getJobs(["waiting"])).filter((x) => x.id === j.jobId);
    expect(same).toHaveLength(1);
    await p.close();
  });

  it("closes the producer even when Redis is unreachable and QUIT cannot be sent", async () => {
    const url = new URL(redisUrl);
    url.host = `127.0.0.1:${proxy.port}`;
    const connection = await connectProducer(url.toString());
    await proxy.setMode("down");
    await expect.poll(() => connection.status, { timeout: 5_000 }).not.toBe("ready");
    await expect(closeProducer(connection)).resolves.toBeUndefined();
    // Closed for good: with Redis back, the abandoned client must not reconnect.
    await proxy.setMode("forward");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(connection.status).not.toBe("ready");
  });

  it("refuses to start against an unreachable Redis instead of waiting", async () => {
    await proxy.setMode("down");
    await expect(connectProducer(`redis://127.0.0.1:${proxy.port}`)).rejects.toThrow();
    await proxy.setMode("forward");
  });
});
