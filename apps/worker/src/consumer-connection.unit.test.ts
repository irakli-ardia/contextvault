import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeConsumer } from "./consumer-connection";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// A QUIT whose reply never comes (a half-open connection) must not hold shutdown.
function fakeRedis(quit: () => Promise<"OK">) {
  const disconnect = vi.fn();
  return { redis: { quit, disconnect }, disconnect };
}

describe("closeConsumer", () => {
  it("disconnects after the bound when QUIT never settles", async () => {
    const { redis, disconnect } = fakeRedis(() => new Promise(() => undefined));
    const closing = closeConsumer(redis, 1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disconnects at once and stays quiet when QUIT answers or rejects", async () => {
    for (const quit of [async () => "OK" as const, () => Promise.reject(new Error("closed"))]) {
      const { redis, disconnect } = fakeRedis(quit);
      await closeConsumer(redis, 1_000);
      expect(disconnect).toHaveBeenCalledTimes(1);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
