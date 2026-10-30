import { type DispatchOutboxResult, parseOutboxId } from "@contextvault/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDispatcherLoop } from "./dispatcher-loop";

const result = (over: Partial<DispatchOutboxResult> = {}): DispatchOutboxResult => ({
  dispatched: 0,
  alreadyDispatched: 0,
  failures: [],
  next: null,
  aborted: false,
  ...over,
});
const failure = {
  outboxId: parseOutboxId("00000000-0000-4000-8000-000000000001"),
  error: new Error("redis down"),
};
const down = result({ failures: [failure], aborted: true, next: "c" });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const start = (scan: Parameters<typeof startDispatcherLoop>[0]["scan"]) => {
  const log = vi.fn();
  const loop = startDispatcherLoop({ scan, pollMs: 1_000, maxBackoffMs: 8_000, log });
  return { loop, log };
};

describe("startDispatcherLoop", () => {
  it("never overlaps scans: the next tick is armed only after the last one ends", async () => {
    let active = 0;
    let peak = 0;
    const scan = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      active -= 1;
      return result();
    });
    const { loop } = start(scan);
    await vi.advanceTimersByTimeAsync(20_000);
    const stopping = loop.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    expect(scan.mock.calls.length).toBeGreaterThan(2);
    expect(peak).toBe(1);
  });

  it("passes the cursor on, and starts over once a scan reports the end", async () => {
    const scan = vi
      .fn()
      .mockResolvedValueOnce(result({ next: "a" }))
      .mockResolvedValueOnce(result({ next: null }))
      .mockResolvedValue(result());
    const { loop } = start(scan);
    await vi.advanceTimersByTimeAsync(3_000);
    await loop.stop();
    expect(scan.mock.calls.slice(0, 3).map(([after]) => after)).toEqual([null, "a", null]);
  });

  it("follows a full page at once, without waiting for the poll interval", async () => {
    const scan = vi
      .fn()
      .mockResolvedValueOnce(result({ next: "a" }))
      .mockResolvedValue(result());
    const { loop } = start(scan);
    await vi.advanceTimersByTimeAsync(10); // far below pollMs
    await loop.stop();
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially up to the cap, then recovers the normal poll", async () => {
    let healthy = false;
    const times: number[] = [];
    const scan = vi.fn(async () => {
      times.push(Date.now());
      return healthy ? result() : down;
    });
    const { loop } = start(scan);
    await vi.advanceTimersByTimeAsync(60_000);
    const gaps = times.slice(1).map((t, i) => t - (times[i] ?? 0));
    expect(gaps.slice(0, 5)).toEqual([2_000, 4_000, 8_000, 8_000, 8_000]);

    healthy = true;
    await vi.advanceTimersByTimeAsync(8_000);
    const recovered = times.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(times.length - recovered).toBe(3);
    await loop.stop();
  });

  it("treats a scan that only failed as unhealthy, and a throwing scan as unhealthy too", async () => {
    const scan = vi
      .fn()
      .mockResolvedValueOnce(result({ failures: [failure] }))
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(result());
    const { loop, log } = start(scan);
    await vi.advanceTimersByTimeAsync(0); // 1st scan, now at 1 unhealthy tick: 2 s wait
    await vi.advanceTimersByTimeAsync(1_999);
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 2nd throws: 2 unhealthy ticks, 4 s wait
    expect(scan).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(scan).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(3);
    await loop.stop();
    expect(log).toHaveBeenCalledWith({
      level: "error",
      code: "OUTBOX_SCAN_FAILED",
      cause: "Error",
    });
    expect(log).toHaveBeenCalledWith({
      level: "warn",
      code: "OUTBOX_DISPATCH_FAILED",
      failures: 1,
      causes: ["Error"],
    });
    const logged = JSON.stringify(log.mock.calls);
    for (const secret of ["db down", "redis down", "00000000-0000-4000"]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("stop waits for the scan in flight and arms nothing more", async () => {
    let finish: (() => void) | undefined;
    const scan = vi.fn(
      () =>
        new Promise<DispatchOutboxResult>((resolve) => {
          finish = () => resolve(result({ next: "a" }));
        }),
    );
    const { loop } = start(scan);
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stopped).toBe(false);
    finish?.();
    await stopping;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop before the first tick leaves no timer", async () => {
    const scan = vi.fn().mockResolvedValue(result());
    const { loop } = start(scan);
    await loop.stop();
    expect(scan).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
