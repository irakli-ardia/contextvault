import { describe, expect, it } from "vitest";
import { TransactionOutcomeUnknown } from "../kernel/errors";
import { parseWorkspaceId } from "../kernel/ids";
import { workspaceId } from "./fakes";
import { recoverExpiredLease } from "./recover-expired-lease";
import { fakeRecovery } from "./recovery-fakes";
import { leaseDurationMs } from "./recovery-policy";
import type { RecoveryUnitOfWork } from "./recovery-ports";

const setup = (status: "parsing" | "chunking" = "parsing", attempt = 1) => {
  const f = fakeRecovery();
  const id = f.addVersion(1, status, { leaseGeneration: 4, attempt });
  f.beat(id);
  const recover = (observedGeneration = 4, uow: RecoveryUnitOfWork = f.uow) =>
    recoverExpiredLease(
      { uow, newId: f.newId },
      { workspaceId, versionId: id, observedGeneration },
    );
  return { f, id, recover };
};

describe("recoverExpiredLease", () => {
  it("skips a live lease and changes nothing", async () => {
    const { f, id, recover } = setup();
    f.advance(leaseDurationMs - 1);
    expect(await recover()).toEqual({ outcome: "skipped" });
    expect(f.versions.get(id)).toMatchObject({ status: "parsing", leaseGeneration: 4 });
    expect(f.outbox.size).toBe(0);
  });

  it.each([
    ["parsing", 1, 5_000],
    ["chunking", 2, 10_000],
  ] as const)(
    "requeues an expired %s lease at attempt %i after %i ms",
    async (status, attempt, delayMs) => {
      const { f, id, recover } = setup(status, attempt);
      f.advance(leaseDurationMs);
      const now = f.clock.now.getTime();

      expect(await recover()).toEqual({ outcome: "retry", delayMs });
      expect(f.versions.get(id)).toMatchObject({ status: "queued", leaseGeneration: 5, attempt });
      const rows = [...f.outbox.values()];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.entry.versionId).toBe(id);
      expect(rows[0]?.entry.workspaceId).toBe(workspaceId);
      expect(rows[0]?.entry.availableAt.getTime()).toBe(now + delayMs);
      expect(rows[0]?.entry.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows[0]?.entry.id).not.toBe(id);
    },
  );

  it("fails an expired lease whose attempts are spent, keeping the stage", async () => {
    const { f, id, recover } = setup("chunking", 3);
    f.advance(leaseDurationMs);
    expect(await recover()).toEqual({ outcome: "failed" });
    expect(f.versions.get(id)).toMatchObject({
      status: "failed",
      leaseGeneration: 5,
      attempt: 3,
      failure: { stage: "chunking", code: "lease.expired", retryable: true },
    });
    expect(f.outbox.size).toBe(0);
  });

  it("skips a stale observed generation", async () => {
    const { f, id, recover } = setup();
    f.advance(leaseDurationMs);
    expect(await recover(3)).toEqual({ outcome: "skipped" });
    expect(f.versions.get(id)?.leaseGeneration).toBe(4);
  });

  it("is idempotent: a second call is stale and adds no outbox row", async () => {
    const { f, recover } = setup();
    f.advance(leaseDurationMs);
    await recover();
    expect(await recover()).toEqual({ outcome: "skipped" });
    expect(f.outbox.size).toBe(1);
  });

  it("rolls back the generation bump when the fenced transition loses", async () => {
    const { f, id, recover } = setup();
    f.advance(leaseDurationMs);
    f.faults.claimedMeanwhile = true;
    await expect(recover()).rejects.toThrow("fenced transition lost");
    expect(f.versions.get(id)).toMatchObject({ status: "parsing", leaseGeneration: 4 });
    expect(f.outbox.size).toBe(0);
  });

  it("rolls back the generation bump when the terminal fenced failVersion loses", async () => {
    const { f, id, recover } = setup("chunking", 3);
    f.advance(leaseDurationMs);
    f.faults.claimedMeanwhile = true;
    await expect(recover()).rejects.toThrow(`fenced failVersion lost for ${id}`);
    expect(f.versions.get(id)).toEqual({ id, status: "chunking", leaseGeneration: 4, attempt: 3 });
    expect(f.outbox.size).toBe(0);

    // Rollback is real: the original lease is still expired and recoverable.
    f.faults.claimedMeanwhile = false;
    expect(await recover()).toEqual({ outcome: "failed" });
    expect(f.versions.get(id)).toMatchObject({ status: "failed", leaseGeneration: 5, attempt: 3 });
  });

  it("does not treat a heartbeat from before a recovery as the new claim's heartbeat", async () => {
    const { f, id, recover } = setup();
    f.advance(leaseDurationMs);
    expect(await recover()).toEqual({ outcome: "retry", delayMs: 5_000 });
    f.advance(5_000);
    const claimed = await f.uow.run({ workspaceId }, ({ ingestion }) =>
      ingestion.claim({ versionId: id }),
    );
    expect(claimed).toMatchObject({ leaseGeneration: 6 });
    expect(await f.recoverySource.listExpiredLeases(10, leaseDurationMs)).toEqual([]);
  });

  it("rolls back the transition and the bump when the outbox insert fails", async () => {
    const { f, id, recover } = setup();
    f.advance(leaseDurationMs);
    f.faults.insertOutbox = true;
    await expect(recover()).rejects.toThrow("connection lost");
    expect(f.versions.get(id)).toMatchObject({ status: "parsing", leaseGeneration: 4 });
    expect(f.outbox.size).toBe(0);
  });

  it("rejects a non-running status reported after a successful expiry", async () => {
    const { f, id, recover } = setup();
    f.advance(leaseDurationMs);
    const lying: RecoveryUnitOfWork = {
      run: (context, work, options) =>
        f.uow.run(
          context,
          (repos) =>
            work({
              ...repos,
              recovery: {
                expireLease: async () => ({ status: "queued", attempt: 1, leaseGeneration: 5 }),
              },
            }),
          options,
        ),
    };
    await expect(recover(4, lying)).rejects.toThrow("non-running status queued");
    expect(f.versions.get(id)?.status).toBe("parsing");
    expect(f.outbox.size).toBe(0);
  });

  it("propagates TransactionOutcomeUnknown", async () => {
    const { f, recover } = setup();
    f.advance(leaseDurationMs);
    f.faults.lostAck = true;
    await expect(recover()).rejects.toBeInstanceOf(TransactionOutcomeUnknown);
  });

  it("cannot recover a version through an unknown workspace", async () => {
    const { f, id } = setup();
    f.advance(leaseDurationMs);
    const stranger = parseWorkspaceId("00000000-0000-4000-8000-0000000000ff");
    await expect(
      recoverExpiredLease(
        { uow: f.uow, newId: f.newId },
        { workspaceId: stranger, versionId: id, observedGeneration: 4 },
      ),
    ).rejects.toThrow("unknown workspace");
    expect(f.versions.get(id)).toMatchObject({ status: "parsing", leaseGeneration: 4 });
    expect(f.outbox.size).toBe(0);
  });
});
