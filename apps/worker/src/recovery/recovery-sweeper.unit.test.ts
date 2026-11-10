import {
  parseDocumentVersionId,
  parseWorkspaceId,
  type SweepBatch,
  type SweepRecoveryDeps,
  type SweepRecoveryResult,
  sweepRecovery,
} from "@contextvault/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRecoverySweeper } from "./recovery-sweeper";

const batch = (over: Partial<SweepBatch> = {}): SweepBatch => ({
  candidates: 0,
  acted: 0,
  skipped: 0,
  errors: [],
  ...over,
});
const result = (
  leases: Partial<SweepBatch> = {},
  orphans: Partial<SweepBatch> = {},
): SweepRecoveryResult => ({ leases: batch(leases), orphans: batch(orphans) });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const start = (sweep: (signal: AbortSignal) => Promise<SweepRecoveryResult>) => {
  const log = vi.fn();
  const sweeper = startRecoverySweeper({ sweep, intervalMs: 30_000, log });
  return { sweeper, log };
};
const codes = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map(([e]) => e.code);

describe("startRecoverySweeper", () => {
  it("waits one interval for the first sweep, then repeats every interval", async () => {
    const sweep = vi.fn(async () => result());
    const { sweeper } = start(sweep);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(3);
    await sweeper.stop();
  });

  it("never overlaps: a sweep slower than the interval delays the next one", async () => {
    let active = 0;
    let peak = 0;
    const sweep = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 100_000));
      active -= 1;
      return result();
    });
    const { sweeper } = start(sweep);
    await vi.advanceTimersByTimeAsync(300_000);
    const stopping = sweeper.stop();
    await vi.advanceTimersByTimeAsync(100_000);
    await stopping;
    expect(sweep.mock.calls.length).toBeGreaterThan(1);
    expect(peak).toBe(1);
  });

  it("stop() waits for the sweep in flight and schedules nothing afterwards", async () => {
    let finish: () => void = () => undefined;
    const sweep = vi.fn(
      () =>
        new Promise<SweepRecoveryResult>((resolve) => {
          finish = () => resolve(result());
        }),
    );
    const { sweeper } = start(sweep);
    await vi.advanceTimersByTimeAsync(30_000);
    let stopped = false;
    const stopping = sweeper.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("stop() before the first sweep cancels it", async () => {
    const sweep = vi.fn(async () => result());
    const { sweeper } = start(sweep);
    await sweeper.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("warns when a whole batch was skipped, and not for a partial skip or an empty one", async () => {
    const sweep = vi
      .fn<() => Promise<SweepRecoveryResult>>()
      .mockResolvedValueOnce(result({ candidates: 3, skipped: 3 }))
      .mockResolvedValueOnce(result({ candidates: 3, skipped: 1, acted: 2 }))
      .mockResolvedValue(result());
    const { sweeper, log } = start(sweep);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log).toHaveBeenCalledWith({
      level: "warn",
      code: "RECOVERY_BATCH_SKIPPED",
      batch: "leases",
      candidates: 3,
    });
    log.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(codes(log)).toEqual(["RECOVERY_ACTED"]);
    log.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log).not.toHaveBeenCalled();
    await sweeper.stop();
  });

  it("logs per-candidate failures as counts and labels only, never error text", async () => {
    const sweep = vi.fn(async () =>
      result({ candidates: 2, errors: [new Error("secret postgres://u:p@h"), new TypeError("x")] }),
    );
    const { sweeper, log } = start(sweep);
    await vi.advanceTimersByTimeAsync(30_000);
    await sweeper.stop();
    const [entry] = log.mock.calls[0] ?? [];
    expect(entry).toMatchObject({ code: "RECOVERY_ITEMS_FAILED", failures: 2 });
    expect(JSON.stringify(entry)).not.toContain("secret");
  });

  it("a failed sweep is logged and retried at the next interval, not sooner", async () => {
    const sweep = vi
      .fn<() => Promise<SweepRecoveryResult>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(result());
    const { sweeper, log } = start(sweep);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(codes(log)).toEqual(["RECOVERY_SWEEP_FAILED"]);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    await sweeper.stop();
  });

  it("SIGTERM during a sweep: the real sweep stops between candidates and stop() waits only for the transaction in flight", async () => {
    const ws = parseWorkspaceId("00000000-0000-4000-8000-0000000000a1");
    const candidate = (n: number) => ({
      workspaceId: ws,
      versionId: parseDocumentVersionId(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
      observedGeneration: 1,
    });
    let finishFirst: () => void = () => undefined;
    const recover = vi.fn<SweepRecoveryDeps["recover"]>(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve({ outcome: "failed" });
        }),
    );
    const redrive = vi.fn<SweepRecoveryDeps["redrive"]>(async () => ({ outcome: "redriven" }));
    const listWaiting = vi.fn(async () => []);
    const deps: SweepRecoveryDeps = {
      recoverySource: { listExpiredLeases: async () => [1, 2, 3, 4, 5].map(candidate) },
      orphanSource: { listWaiting },
      recover,
      redrive,
      leaseDurationMs: 300_000,
    };
    const { sweeper, log } = start((signal) => sweepRecovery(deps, 50, signal));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(recover).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = sweeper.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toBe(false); // still waiting for the transaction in flight
    finishFirst();
    await stopping;
    expect(recover).toHaveBeenCalledTimes(1); // candidates 2..5 never started
    expect(listWaiting).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith({
      level: "info",
      code: "RECOVERY_ACTED",
      batch: "leases",
      acted: 1,
    });
  });

  it("an abort during a sweep arms no further timer", async () => {
    let finish: () => void = () => undefined;
    const sweep = vi.fn(
      () =>
        new Promise<SweepRecoveryResult>((resolve) => {
          finish = () => resolve(result());
        }),
    );
    const { sweeper } = start(sweep);
    await vi.advanceTimersByTimeAsync(30_000);
    const stopping = sweeper.stop();
    finish();
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
