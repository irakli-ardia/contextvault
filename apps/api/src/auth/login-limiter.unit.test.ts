import { describe, expect, it } from "vitest";
import { accountPolicy, ipPolicy, LoginLimiter } from "./login-limiter";

const min = 60_000;

describe("LoginLimiter", () => {
  it("allows failures below the limit, then blocks with a growing delay capped at the window", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < accountPolicy.limit - 1; i++) l.recordFailure("a", accountPolicy, 0);
    expect(l.retryAfterSeconds(["a"], 0)).toBeNull();
    l.recordFailure("a", accountPolicy, 0);
    expect(l.retryAfterSeconds(["a"], 0)).toBe(30);
    l.recordFailure("a", accountPolicy, 0);
    expect(l.retryAfterSeconds(["a"], 0)).toBe(60);
    for (let i = 0; i < 20; i++) l.recordFailure("a", accountPolicy, 0);
    expect(l.retryAfterSeconds(["a"], 0)).toBe(15 * 60);
  });

  it("unblocks after the delay and forgets after the window", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < ipPolicy.limit; i++) l.recordFailure("ip", ipPolicy, 0);
    expect(l.retryAfterSeconds(["ip"], 15 * min - 1)).toBe(1);
    expect(l.retryAfterSeconds(["ip"], 15 * min)).toBeNull();
  });

  it("reports the longest wait across keys and clears one key on success", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < accountPolicy.limit; i++) l.recordFailure("acct", accountPolicy, 0);
    expect(l.retryAfterSeconds(["ip", "acct"], 0)).toBe(30);
    l.clear("acct");
    expect(l.retryAfterSeconds(["ip", "acct"], 0)).toBeNull();
  });

  it("stays bounded under a flood of distinct keys", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 10_050; i++) l.recordFailure(`k${i}`, accountPolicy, 0);
    // The oldest keys were evicted; the newest are retained.
    for (let i = 0; i < accountPolicy.limit; i++) l.recordFailure("k0", accountPolicy, 0);
    expect(l.retryAfterSeconds(["k0"], 0)).toBe(30);
    expect(l.retryAfterSeconds(["k10049"], 0)).toBeNull();
  });
});
