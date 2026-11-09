import { describe, expect, it } from "vitest";
import { testRedisUrl } from "./test-redis-url";

const local = "redis://:pw@127.0.0.1:56379";

describe("testRedisUrl", () => {
  it("accepts the verified local stack", () => {
    expect(testRedisUrl(local, { CV_TEST_STACK_VERIFIED: "1" }).port).toBe("56379");
  });

  it("accepts a loopback Redis service on GitHub Actions, on any port", () => {
    const ci = { GITHUB_ACTIONS: "true", CI: "true" };
    expect(testRedisUrl("redis://:pw@127.0.0.1:6379", ci).port).toBe("6379");
  });

  it("refuses an unverified local run", () => {
    expect(() => testRedisUrl("redis://127.0.0.1:6379", {})).toThrow("refused");
  });

  it("does not trust CI=true alone, or a non-loopback host on GitHub Actions", () => {
    expect(() => testRedisUrl(local, { CI: "true" })).toThrow("refused");
    const ci = { GITHUB_ACTIONS: "true", CI: "true" };
    expect(() => testRedisUrl("redis://redis.internal:6379", ci)).toThrow("refused");
  });
});
