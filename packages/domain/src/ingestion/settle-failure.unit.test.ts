import { describe, expect, it } from "vitest";
import { dispatchOutbox } from "./dispatch-outbox";
import { fakeIngestion, versionId, workspaceId } from "./fakes";
import type { IngestionFailure } from "./lifecycle";
import { settleFailure } from "./settle-failure";

const now = new Date("2026-10-30T12:00:00Z");
const transient: IngestionFailure = {
  stage: "parsing",
  code: "storage.unavailable",
  retryable: true,
};

const setup = () => {
  const f = fakeIngestion();
  const settle = (
    id: ReturnType<typeof f.addVersion>,
    over: { leaseGeneration?: number; failure?: IngestionFailure } = {},
  ) =>
    settleFailure(
      { uow: f.uow, newId: f.newId },
      { workspaceId, versionId: id, leaseGeneration: 1, failure: transient, now, ...over },
    );
  return { f, settle };
};

describe("settleFailure", () => {
  it.each([
    [1, 5_000],
    [2, 10_000],
  ])("requeues attempt %i after %i ms with a new outbox row", async (attempt, delayMs) => {
    const { f, settle } = setup();
    const id = f.addVersion(1, "parsing", { leaseGeneration: 1, attempt });

    const availableAt = new Date(now.getTime() + delayMs);
    expect(await settle(id)).toEqual({ outcome: "retry", availableAt });
    expect(f.versions.get(id)?.status).toBe("queued");
    expect([...f.outbox.values()].map((r) => [r.entry.versionId, r.entry.availableAt])).toEqual([
      [id, availableAt],
    ]);
  });

  it("fails the third attempt, recording stage, code and retryability", async () => {
    const { f, settle } = setup();
    const id = f.addVersion(1, "chunking", { leaseGeneration: 1, attempt: 3 });
    const failure = { ...transient, stage: "chunking" } as const;

    expect(await settle(id, { failure })).toEqual({ outcome: "failed" });
    expect(f.versions.get(id)).toMatchObject({ status: "failed", failure });
    expect(f.outbox.size).toBe(0);
  });

  it("fails a non-retryable error on the first attempt", async () => {
    const { f, settle } = setup();
    const id = f.addVersion(1, "parsing", { leaseGeneration: 1, attempt: 1 });
    const failure = { stage: "parsing", code: "parse.encrypted", retryable: false } as const;

    expect(await settle(id, { failure })).toEqual({ outcome: "failed" });
    expect(f.versions.get(id)).toMatchObject({ status: "failed", failure });
  });

  it.each([
    ["a newer claim", "parsing", 2],
    ["a version not running", "queued", 1],
    ["a finished version", "failed", 1],
  ] as const)("writes nothing for %s", async (_name, status, leaseGeneration) => {
    const { f, settle } = setup();
    const id = f.addVersion(1, status, { leaseGeneration, attempt: 1 });
    expect(await settle(id)).toEqual({ outcome: "stale" });
    expect(f.versions.get(id)?.status).toBe(status);
    expect(f.outbox.size).toBe(0);
  });

  it.each([
    ["a retry", transient, 1, "parsing"],
    ["a final failure", { ...transient, retryable: false }, 1, "parsing"],
  ] as const)(
    "writes nothing for %s when a newer claim lands before the write",
    async (_n, failure, attempt, status) => {
      const { f, settle } = setup();
      const id = f.addVersion(1, status, { leaseGeneration: 1, attempt });
      f.faults.claimedMeanwhile = true;

      expect(await settle(id, { failure })).toEqual({ outcome: "stale" });
      expect(f.versions.get(id)).toMatchObject({ status, leaseGeneration: 2 });
      expect(f.versions.get(id)).not.toHaveProperty("failure");
      expect(f.outbox.size).toBe(0);
    },
  );

  it("rolls the version back to running when the retry's outbox row cannot be written", async () => {
    const { f, settle } = setup();
    const id = f.addVersion(1, "parsing", { leaseGeneration: 1, attempt: 1 });
    f.faults.insertOutbox = true;

    await expect(settle(id)).rejects.toThrow("connection lost");
    expect(f.versions.get(id)?.status).toBe("parsing");
    expect(f.outbox.size).toBe(0);
  });

  it("is stale for an unknown version", async () => {
    const { settle } = setup();
    expect(await settle(versionId(99))).toEqual({ outcome: "stale" });
  });

  it("settles a duplicate report once", async () => {
    const { f, settle } = setup();
    const id = f.addVersion(1, "parsing", { leaseGeneration: 1, attempt: 1 });
    await settle(id);
    expect(await settle(id)).toEqual({ outcome: "stale" });
    expect(f.outbox.size).toBe(1);
  });

  it("makes the retry deliverable only after its backoff, under a fresh job id", async () => {
    const { f, settle } = setup();
    const id = f.addVersion(1, "parsing", { leaseGeneration: 1, attempt: 1 });
    await settle(id);
    const deps = { source: f.source, queue: f.queue, uow: f.uow };

    expect(await dispatchOutbox(deps, new Date(now.getTime() + 4_999), 10)).toEqual({
      dispatched: 0,
      alreadyDispatched: 0,
      failures: [],
    });
    expect(await dispatchOutbox(deps, new Date(now.getTime() + 5_000), 10)).toEqual({
      dispatched: 1,
      alreadyDispatched: 0,
      failures: [],
    });
    expect(f.jobs.size).toBe(1);
    expect(f.versions.get(id)?.status).toBe("queued");
  });
});
