import { randomUUID } from "node:crypto";
import { type DocumentVersionId, redriveOrphan } from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { gate, seedOrphan } from "./orphan-test-support";
import { waitUntilBlocked } from "./recovery-test-support";
import { createIngestionHarness } from "./testing/ingestion-test-support";

// Redrive against claim and against other redrives, ordered by barriers and observed in pg_locks.
// Each case names its serial order: the second transaction must behave as if it ran after the first.
const h = await createIngestionHarness();
const { wsA } = h;
const orphans = h.worker.orphanUnitOfWork;

afterAll(() => h.close());

const live = async (id: string) => (await h.outboxRows(id)).filter((e) => e.dispatched_at === null);
const redrive = (versionId: DocumentVersionId, uow = orphans) =>
  redriveOrphan({ uow, newId: randomUUID }, { workspaceId: wsA, versionId });

describe("redrive racing with a claim", () => {
  // Serial order: claim, then redrive. A duplicate delivery claims an unclaimed version whose
  // entry was already dispatched, so a claim needs no live entry to win.
  it("claim holds the version lock first: the redrive waits, sees `parsing` and skips", async () => {
    const id = await seedOrphan(h, wsA, { attempt: 1 });
    const claimer = gate(h.worker.unitOfWork);
    try {
      const claiming = claimer.uow.run({ workspaceId: wsA }, ({ ingestion }) =>
        ingestion.claim({ versionId: id }),
      );
      await claimer.entered;
      const redriving = redrive(id);
      await waitUntilBlocked(h, id);
      claimer.release();
      expect(await claiming).toEqual({ leaseGeneration: 1, attempt: 2 });
      expect(await redriving).toEqual({ outcome: "skipped" });
    } finally {
      claimer.release();
    }
    expect(await h.row(id)).toMatchObject({ status: "parsing", attempt: 2, lease_generation: 1 });
    expect(await h.outboxRows(id)).toEqual([]);
  });
});

describe("concurrent redrives", () => {
  // Serial order: the first to take the version lock, then every other one against its entry.
  it("a winner that rolls back releases the lock: the waiter re-checks and redrives", async () => {
    const id = await seedOrphan(h, wsA, { attempt: 1 });
    const before = await h.row(id);
    const first = gate(orphans, { rollback: true });
    try {
      const doomed = redrive(id, first.uow);
      await first.entered;
      const waiter = redrive(id);
      await waitUntilBlocked(h, id);
      first.release();
      await expect(doomed).rejects.toThrow("rolled back by the test");
      expect(await waiter).toEqual({ outcome: "redriven" });
    } finally {
      first.release();
    }
    // The rolled-back entry left no trace: one row, and it is the waiter's.
    expect(await h.outboxRows(id)).toHaveLength(1);
    expect(await live(id)).toHaveLength(1);
    expect(await h.row(id)).toEqual(before);
    await h.fx.fixture.query("select 1 from document_versions where id = $1 for update nowait", [
      id,
    ]);
  });

  it("many simultaneous redrives: exactly one wins, the rest skip", async () => {
    const id = await seedOrphan(h, wsA);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => redrive(id)));
    expect(outcomes.filter((o) => o.outcome === "redriven")).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "skipped")).toHaveLength(5);
    expect(await h.outboxRows(id)).toHaveLength(1);
    expect(await live(id)).toHaveLength(1);
  });
});
