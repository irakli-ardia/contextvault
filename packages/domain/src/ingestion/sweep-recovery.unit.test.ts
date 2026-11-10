import { describe, expect, it, vi } from "vitest";
import { parseDocumentVersionId, parseWorkspaceId } from "../kernel/ids";
import { fullySkipped, type SweepRecoveryDeps, sweepRecovery } from "./sweep-recovery";

const ws = parseWorkspaceId("00000000-0000-4000-8000-0000000000a1");
const vid = (n: number) =>
  parseDocumentVersionId(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const lease = (n: number) => ({ workspaceId: ws, versionId: vid(n), observedGeneration: 1 });
const orphan = (n: number) => ({ workspaceId: ws, versionId: vid(n), cursor: `c${n}` });

const setup = (over: { leases?: number[]; orphans?: number[] } = {}) => {
  const recoverySource = {
    listExpiredLeases: vi.fn(async () => (over.leases ?? []).map(lease)),
  };
  const orphanSource = { listWaiting: vi.fn(async () => (over.orphans ?? []).map(orphan)) };
  const recover = vi.fn<SweepRecoveryDeps["recover"]>(async () => ({ outcome: "failed" }));
  const redrive = vi.fn<SweepRecoveryDeps["redrive"]>(async () => ({ outcome: "redriven" }));
  const deps = { recoverySource, orphanSource, recover, redrive, leaseDurationMs: 300_000 };
  return { deps, recoverySource, orphanSource, recover, redrive };
};

/** The domain has no DOM typings, so the abort signal is the `DeadlineSignal` subset. */
const fakeSignal = (aborted = false) => {
  const signal = {
    aborted,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return {
    signal,
    abort: () => {
      signal.aborted = true;
    },
  };
};

describe("sweepRecovery", () => {
  it("asks each source for one page of at most the batch size", async () => {
    const s = setup();
    await sweepRecovery(s.deps, 7);
    expect(s.recoverySource.listExpiredLeases).toHaveBeenCalledExactlyOnceWith(7, 300_000);
    expect(s.orphanSource.listWaiting).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("recovers and redrives every candidate and counts them", async () => {
    const s = setup({ leases: [1, 2], orphans: [3] });
    const r = await sweepRecovery(s.deps, 50);
    expect(r.leases).toMatchObject({ candidates: 2, acted: 2, skipped: 0, errors: [] });
    expect(r.orphans).toMatchObject({ candidates: 1, acted: 1, skipped: 0 });
    expect(s.recover).toHaveBeenCalledWith(lease(1));
    expect(s.redrive).toHaveBeenCalledWith({ workspaceId: ws, versionId: vid(3), cursor: "c3" });
  });

  it("isolates a failing candidate: the rest of the batch still runs", async () => {
    const s = setup({ leases: [1, 2, 3] });
    s.recover
      .mockResolvedValueOnce({ outcome: "retry", delayMs: 1 })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ outcome: "skipped" });
    const r = await sweepRecovery(s.deps, 50);
    expect(r.leases).toMatchObject({ candidates: 3, acted: 1, skipped: 1 });
    expect(r.leases.errors).toHaveLength(1);
    expect(s.recover).toHaveBeenCalledTimes(3);
  });

  it("still sweeps orphans when every lease candidate fails", async () => {
    const s = setup({ leases: [1], orphans: [2] });
    s.recover.mockRejectedValue(new Error("db"));
    const r = await sweepRecovery(s.deps, 50);
    expect(r.orphans.acted).toBe(1);
  });

  it("propagates a discovery failure", async () => {
    const s = setup();
    s.recoverySource.listExpiredLeases.mockRejectedValue(new Error("down"));
    await expect(sweepRecovery(s.deps, 50)).rejects.toThrow("down");
  });

  it("an empty sweep is not fully skipped; an all-skipped batch is; a partial skip is not", async () => {
    const s = setup({ orphans: [1, 2] });
    s.redrive.mockResolvedValue({ outcome: "skipped" });
    expect(fullySkipped((await sweepRecovery(s.deps, 50)).orphans)).toBe(true);
    s.redrive.mockResolvedValueOnce({ outcome: "redriven" });
    expect(fullySkipped((await sweepRecovery(s.deps, 50)).orphans)).toBe(false);
    expect(fullySkipped((await sweepRecovery(setup().deps, 50)).leases)).toBe(false);
  });

  it("stops between candidates once aborted: the one in flight finishes, no more start", async () => {
    const s = setup({ leases: [1, 2, 3], orphans: [4] });
    const abort = fakeSignal();
    let finish: () => void = () => undefined;
    s.recover.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ outcome: "failed" });
        }),
    );
    const sweeping = sweepRecovery(s.deps, 50, abort.signal);
    await vi.waitFor(() => expect(s.recover).toHaveBeenCalledTimes(1));
    abort.abort();
    expect(s.recover).toHaveBeenCalledTimes(1);
    finish();
    const r = await sweeping;
    expect(s.recover).toHaveBeenCalledTimes(1);
    expect(s.redrive).not.toHaveBeenCalled();
    expect(s.orphanSource.listWaiting).not.toHaveBeenCalled();
    expect(r.leases).toMatchObject({ acted: 1, errors: [] }); // the in-flight one was counted
    expect(fullySkipped(r.leases)).toBe(false);
  });

  it("does no discovery and no work when already aborted", async () => {
    const s = setup({ leases: [1], orphans: [2] });
    const r = await sweepRecovery(s.deps, 50, fakeSignal(true).signal);
    expect(s.recoverySource.listExpiredLeases).not.toHaveBeenCalled();
    expect(s.orphanSource.listWaiting).not.toHaveBeenCalled();
    expect(r.leases.candidates + r.orphans.candidates).toBe(0);
  });
});
