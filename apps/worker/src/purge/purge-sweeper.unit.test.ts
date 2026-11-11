import type { PurgeBatch } from "@contextvault/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPurgeSweeper } from "./purge-sweeper";

const batch = (over: Partial<PurgeBatch> = {}): PurgeBatch => ({
  candidates: 0,
  purged: 0,
  skipped: 0,
  errors: [],
  ...over,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const start = (sweep: (signal: AbortSignal) => Promise<PurgeBatch>) => {
  const log = vi.fn();
  return { sweeper: startPurgeSweeper({ sweep, intervalMs: 60_000, log }), log };
};
const codes = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map(([e]) => e.code);

describe("startPurgeSweeper", () => {
  it("waits one interval, then repeats", async () => {
    const sweep = vi.fn(async () => batch());
    const { sweeper } = start(sweep);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    await sweeper.stop();
  });

  it("never overlaps: the next sweep is armed only after the last ends", async () => {
    let release: () => void = () => undefined;
    const sweep = vi.fn(
      () =>
        new Promise<PurgeBatch>((done) => {
          release = () => done(batch());
        }),
    );
    const { sweeper } = start(sweep);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    release();
    await sweeper.stop();
  });

  it("logs codes and counts only, and survives a failing sweep", async () => {
    const sweep = vi
      .fn<(s: AbortSignal) => Promise<PurgeBatch>>()
      .mockRejectedValueOnce(new Error("secret detail"))
      .mockResolvedValueOnce(batch({ purged: 2, errors: [new Error("secret detail")] }));
    const { sweeper, log } = start(sweep);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(codes(log)).toEqual(["PURGE_SWEEP_FAILED", "PURGE_ITEMS_FAILED", "PURGE_DONE"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret detail");
    await sweeper.stop();
  });

  it("stop aborts the signal, waits for the sweep in flight and arms nothing more", async () => {
    let seen: AbortSignal | undefined;
    let release: () => void = () => undefined;
    const sweep = vi.fn((signal: AbortSignal) => {
      seen = signal;
      return new Promise<PurgeBatch>((done) => {
        release = () => done(batch());
      });
    });
    const { sweeper } = start(sweep);
    await vi.advanceTimersByTimeAsync(60_000);
    let stopped = false;
    const stopping = sweeper.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen?.aborted).toBe(true);
    expect(stopped).toBe(false);
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
