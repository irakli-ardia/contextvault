import { parseUserId } from "@contextvault/domain";
import { describe, expect, it } from "vitest";
import { MAX_RETRIES_PER_USER, RETRY_WINDOW_MS, RetryLimiter } from "./retry-limiter";

const user = (n: number) => parseUserId(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const throttled = { status: 429, code: "retry.throttled" };

function setup() {
  let now = 1_000_000;
  const limiter = new RetryLimiter(() => now);
  return {
    limiter,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("RetryLimiter", () => {
  it("allows 5 per user per window and refuses the 6th with Retry-After", () => {
    const { limiter, advance } = setup();
    expect(MAX_RETRIES_PER_USER).toBe(5);
    for (let n = 0; n < MAX_RETRIES_PER_USER; n++) limiter.take(user(1));
    advance(20_000);
    try {
      limiter.take(user(1));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ ...throttled, headers: { "Retry-After": "40" } });
    }
  });

  it("counts refused attempts without extending the window", () => {
    const { limiter, advance } = setup();
    for (let n = 0; n < MAX_RETRIES_PER_USER; n++) limiter.take(user(1));
    for (let n = 0; n < 10; n++) {
      expect(() => limiter.take(user(1))).toThrowError(expect.objectContaining(throttled));
    }
    advance(RETRY_WINDOW_MS);
    expect(() => limiter.take(user(1))).not.toThrow();
  });

  it("keeps users independent", () => {
    const { limiter } = setup();
    for (let n = 0; n < MAX_RETRIES_PER_USER; n++) limiter.take(user(1));
    expect(() => limiter.take(user(2))).not.toThrow();
  });

  it("starts a fresh window once the old one ends", () => {
    const { limiter, advance } = setup();
    for (let n = 0; n < MAX_RETRIES_PER_USER; n++) limiter.take(user(1));
    advance(RETRY_WINDOW_MS - 1);
    expect(() => limiter.take(user(1))).toThrowError(expect.objectContaining(throttled));
    advance(1);
    for (let n = 0; n < MAX_RETRIES_PER_USER; n++) limiter.take(user(1));
    expect(() => limiter.take(user(1))).toThrowError(expect.objectContaining(throttled));
  });
});
