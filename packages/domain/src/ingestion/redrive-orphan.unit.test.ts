import { describe, expect, it } from "vitest";
import { TransactionOutcomeUnknown } from "../kernel/errors";
import { parseWorkspaceId } from "../kernel/ids";
import { versionId, workspaceId } from "./fakes";
import { maxAttempts } from "./lifecycle";
import { fakeRecovery } from "./recovery-fakes";
import {
  outboxHistoryCap,
  redriveBaseCooldownMs,
  redriveCooldownMs,
  redriveMaxCooldownMs,
} from "./recovery-policy";
import { redriveOrphan } from "./redrive-orphan";

/** A version with `rows` dispatched outbox rows, idle for `idleMs` since the last. */
const setup = (status: "uploaded" | "queued" = "queued", attempt = 0, rows = 1, idleMs = 0) => {
  const f = fakeRecovery();
  const id = f.addVersion(1, status, { attempt });
  for (let n = 1; n <= rows; n++) {
    const entry = f.addOutbox(n, id);
    const row = f.outbox.get(entry.id);
    if (row) row.dispatchedAt = f.clock.now;
  }
  f.advance(idleMs);
  const redrive = () =>
    redriveOrphan({ uow: f.orphanUow, newId: f.newId }, { workspaceId, versionId: id });
  const live = () => [...f.outbox.values()].filter((r) => !r.dispatchedAt);
  return { f, id, redrive, live };
};

describe("redriveOrphan", () => {
  it.each(["uploaded", "queued"] as const)("redrives an eligible %s version", async (status) => {
    const { f, id, redrive, live } = setup(status, 0, 1, redriveBaseCooldownMs);
    const now = f.clock.now.getTime();
    expect(await redrive()).toEqual({ outcome: "redriven" });
    const rows = live();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entry.versionId).toBe(id);
    expect(rows[0]?.entry.workspaceId).toBe(workspaceId);
    expect(rows[0]?.entry.availableAt.getTime()).toBe(now);
    expect(rows[0]?.entry.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("skips a version the repository cannot see", async () => {
    const f = fakeRecovery();
    const missing = versionId(99);
    expect(
      await redriveOrphan(
        { uow: f.orphanUow, newId: f.newId },
        { workspaceId, versionId: missing },
      ),
    ).toEqual({ outcome: "skipped" });
    expect(f.outbox.size).toBe(0);
  });

  it.each([
    ["parsing", 1],
    ["chunking", 1],
    ["failed", 1],
    ["queued", maxAttempts],
  ] as const)("skips an ineligible %s version at attempt %i", async (status, attempt) => {
    const { f, id, redrive, live } = setup("queued", 0, 1, 1e9);
    f.versions.set(id, { id, status, leaseGeneration: 1, attempt });
    expect(await redrive()).toEqual({ outcome: "skipped" });
    expect(live()).toHaveLength(0);
  });

  it("skips a version that already has live outbox work", async () => {
    const { f, id, redrive, live } = setup("queued", 0, 1, 1e9);
    f.addOutbox(9, id);
    expect(await redrive()).toEqual({ outcome: "skipped" });
    expect(live()).toHaveLength(1);
  });

  it("skips just below the cooldown and redrives exactly at it", async () => {
    const { f, redrive, live } = setup("queued", 0, 1, redriveBaseCooldownMs - 1);
    expect(await redrive()).toEqual({ outcome: "skipped" });
    expect(live()).toHaveLength(0);
    f.advance(1);
    expect(await redrive()).toEqual({ outcome: "redriven" });
    expect(live()).toHaveLength(1);
  });

  it.each([
    [1, 0],
    [2, 0],
    [4, 1],
    [5, 2],
    [8, 0],
    [11, 2],
  ])("applies the geometric cooldown for %i rows at attempt %i", async (rows, attempt) => {
    const need = redriveCooldownMs(rows, attempt);
    const below = setup("queued", attempt, rows, need - 1);
    expect(await below.redrive()).toEqual({ outcome: "skipped" });
    const at = setup("queued", attempt, rows, need);
    expect(await at.redrive()).toEqual({ outcome: "redriven" });
  });

  it("holds the six-hour maximum, with the history cap changing nothing", async () => {
    const rows = outboxHistoryCap + 20;
    const below = setup("queued", 0, rows, redriveMaxCooldownMs - 1);
    expect(await below.redrive()).toEqual({ outcome: "skipped" });
    const at = setup("queued", 0, rows, redriveMaxCooldownMs);
    expect(await at.redrive()).toEqual({ outcome: "redriven" });
  });

  it("leaves status, attempt and lease generation unchanged", async () => {
    const { f, id, redrive } = setup("uploaded", 2, 3, 1e9);
    f.versions.set(id, { id, status: "uploaded", leaseGeneration: 7, attempt: 2 });
    await redrive();
    expect(f.versions.get(id)).toEqual({ id, status: "uploaded", leaseGeneration: 7, attempt: 2 });
  });

  it("is idempotent: a repeat finds live work and adds nothing", async () => {
    const { redrive, live } = setup("queued", 0, 1, 1e9);
    expect(await redrive()).toEqual({ outcome: "redriven" });
    expect(await redrive()).toEqual({ outcome: "skipped" });
    expect(live()).toHaveLength(1);
  });

  it("rolls back when the outbox insert fails", async () => {
    const { f, redrive, live } = setup("queued", 0, 1, 1e9);
    f.faults.insertOutbox = true;
    await expect(redrive()).rejects.toThrow("connection lost");
    expect(live()).toHaveLength(0);
  });

  it("propagates TransactionOutcomeUnknown", async () => {
    const { f, redrive } = setup("queued", 0, 1, 1e9);
    f.faults.lostAck = true;
    await expect(redrive()).rejects.toBeInstanceOf(TransactionOutcomeUnknown);
  });

  it("refuses an unknown workspace", async () => {
    const { f, id, live } = setup("queued", 0, 1, 1e9);
    const stranger = parseWorkspaceId("00000000-0000-4000-8000-0000000000ff");
    await expect(
      redriveOrphan({ uow: f.orphanUow, newId: f.newId }, { workspaceId: stranger, versionId: id }),
    ).rejects.toThrow("unknown workspace");
    expect(live()).toHaveLength(0);
  });

  it("does no queue I/O", async () => {
    const { f, redrive } = setup("queued", 0, 1, 1e9);
    await redrive();
    expect(f.log).toEqual([]);
    expect(f.jobs.size).toBe(0);
  });
});

describe("outboxHistoryCap", () => {
  it("is the smallest row count that saturates the cooldown at every business attempt", () => {
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      expect(redriveCooldownMs(outboxHistoryCap, attempt)).toBe(redriveMaxCooldownMs);
    }
    expect(redriveCooldownMs(outboxHistoryCap - 1, maxAttempts)).toBeLessThan(redriveMaxCooldownMs);
  });

  it("makes capped and uncapped counts equivalent for all counts and attempts", () => {
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      for (let rows = 0; rows <= outboxHistoryCap * 3; rows++) {
        expect(redriveCooldownMs(Math.min(rows, outboxHistoryCap), attempt)).toBe(
          redriveCooldownMs(rows, attempt),
        );
      }
    }
  });
});
