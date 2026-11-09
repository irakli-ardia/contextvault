import { loadWorkerEnv } from "@contextvault/config";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { testRedisUrl } from "../../testing/test-redis-url";

// Runs only against the verified isolated test Redis (scripts/checks/with-test-stack.mjs) or
// GitHub Actions' loopback Redis; a bare local run is refused.
// biome-ignore lint/style/noProcessEnv: launch flags set by the wrapper or the CI runner, not config
const flags = process.env;
const redisUrl = testRedisUrl(loadWorkerEnv().REDIS_URL, flags);

describe("redis connection", () => {
  let redis: Redis | undefined;

  afterEach(async () => {
    await redis?.quit();
  });

  it("authenticates, answers PING and a round trip", async () => {
    redis = new Redis(redisUrl.toString(), { maxRetriesPerRequest: null });
    expect(await redis.ping()).toBe("PONG");
    await redis.set("m0.7:probe", "ok", "EX", 10);
    expect(await redis.get("m0.7:probe")).toBe("ok");
    await redis.del("m0.7:probe");
  });

  it("rejects a connection without the password", async () => {
    const { protocol, host } = new URL(redisUrl);
    redis = new Redis(`${protocol}//${host}`, { maxRetriesPerRequest: 0, lazyConnect: true });
    await expect(redis.ping()).rejects.toThrow(/NOAUTH|Authentication/i);
  });
});
