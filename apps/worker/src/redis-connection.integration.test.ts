import { loadWorkerEnv } from "@contextvault/config";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";

// Needs the Compose stack (`pnpm run infra:up`) and REDIS_URL from `.env`.
describe("redis connection", () => {
  let redis: Redis | undefined;

  afterEach(async () => {
    await redis?.quit();
  });

  it("authenticates, answers PING and a round trip", async () => {
    redis = new Redis(loadWorkerEnv().REDIS_URL, { maxRetriesPerRequest: null });
    expect(await redis.ping()).toBe("PONG");
    await redis.set("m0.7:probe", "ok", "EX", 10);
    expect(await redis.get("m0.7:probe")).toBe("ok");
    await redis.del("m0.7:probe");
  });

  it("rejects a connection without the password", async () => {
    const { protocol, host } = new URL(loadWorkerEnv().REDIS_URL);
    redis = new Redis(`${protocol}//${host}`, { maxRetriesPerRequest: 0, lazyConnect: true });
    await expect(redis.ping()).rejects.toThrow(/NOAUTH|Authentication/i);
  });
});
