import { randomUUID } from "node:crypto";
import {
  type OrphanUnitOfWork,
  parseOutboxId,
  redriveOrphan,
  type WorkspaceId,
} from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { createIngestionHarness } from "../../testing/ingestion-test-support";
import { waitUntilBlocked } from "../recovery/recovery-test-support";
import { hour, type lockOrphan, seedOrphan } from "./orphan-test-support";

// One transaction for lockOrphan and insertOutbox, and the minimal races that show the version
// lock serializes redrives. The wider contention matrix is a later slice.
const h = await createIngestionHarness();
const { wsA, wsB } = h;
const uow = h.worker.orphanUnitOfWork;

afterAll(() => h.close());

const live = async (id: string) => (await h.outboxRows(id)).filter((e) => e.dispatched_at === null);
const redrive = (u: OrphanUnitOfWork, versionId: Parameters<typeof lockOrphan>[2]) =>
  redriveOrphan({ uow: u, newId: randomUUID }, { workspaceId: wsA, versionId });

/** Keeps the transaction open after its work, until released: a barrier, not a sleep. */
function gated(inner: OrphanUnitOfWork) {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const wrapped: OrphanUnitOfWork = {
    run: (context, work, options) =>
      inner.run(
        context,
        async (repos) => {
          const result = await work(repos);
          entered.resolve();
          await gate.promise;
          return result;
        },
        options,
      ),
  };
  return { uow: wrapped, entered: entered.promise, release: gate.resolve };
}

describe("one transaction", () => {
  it("holds the version lock and hides the insert until commit", async () => {
    const id = await seedOrphan(h, wsA);
    await uow.run({ workspaceId: wsA }, async ({ orphan, ingestion }) => {
      expect(await orphan.lockOrphan({ versionId: id, historyCap: 11 })).not.toBeNull();
      await ingestion.insertOutbox({
        id: parseOutboxId(randomUUID()),
        workspaceId: wsA,
        versionId: id,
        delayMs: 0,
      });
      // The version row is locked by this transaction, and the entry is not yet committed.
      await expect(
        h.fx.fixture.query(
          "select 1 from document_versions where id = $1 for no key update nowait",
          [id],
        ),
      ).rejects.toThrow();
      expect(await live(id)).toEqual([]);
    });
    expect(await live(id)).toHaveLength(1);
  });

  it("rolls the insert back on a failure after insertOutbox, changing no version field", async () => {
    const id = await seedOrphan(h, wsA, { attempt: 1 });
    const before = await h.row(id);
    await expect(
      uow.run({ workspaceId: wsA }, async ({ orphan, ingestion }) => {
        await orphan.lockOrphan({ versionId: id, historyCap: 11 });
        await ingestion.insertOutbox({
          id: parseOutboxId(randomUUID()),
          workspaceId: wsA,
          versionId: id,
          delayMs: 0,
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await live(id)).toEqual([]);
    expect(await h.row(id)).toEqual(before);
  });

  it("a committed redrive changes no version field", async () => {
    const id = await seedOrphan(h, wsA, { attempt: 2, updatedAgoMs: 24 * hour });
    const before = await h.row(id);
    expect(await redrive(uow, id)).toEqual({ outcome: "redriven" });
    expect(await h.row(id)).toEqual(before);
  });

  it("is scoped to the supplied workspace: another workspace's version is never redriven", async () => {
    const id = await seedOrphan(h, wsB);
    expect(await redrive(uow, id)).toEqual({ outcome: "skipped" });
    expect(await live(id)).toEqual([]);
    const asOwner = (ws: WorkspaceId) =>
      redriveOrphan({ uow, newId: randomUUID }, { workspaceId: ws, versionId: id });
    expect(await asOwner(wsB)).toEqual({ outcome: "redriven" });
  });
});

describe("racing redrives", () => {
  it("a second redrive waits on the version lock, then sees the committed entry", async () => {
    const id = await seedOrphan(h, wsA);
    const first = gated(uow);
    try {
      const winner = redrive(first.uow, id);
      await first.entered;
      const loser = redrive(uow, id);
      await waitUntilBlocked(h, id);
      first.release();
      expect(await winner).toEqual({ outcome: "redriven" });
      expect(await loser).toEqual({ outcome: "skipped" });
    } finally {
      first.release();
    }
    expect(await live(id)).toHaveLength(1);
  });

  it("two simultaneous redrives create exactly one live entry", async () => {
    const id = await seedOrphan(h, wsA);
    const outcomes = await Promise.all([redrive(uow, id), redrive(uow, id)]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["redriven", "skipped"]);
    expect(await live(id)).toHaveLength(1);
  });

  it("a claim waiting on the redrive's lock consumes the new entry", async () => {
    const id = await seedOrphan(h, wsA);
    const first = gated(uow);
    try {
      const redriving = redrive(first.uow, id);
      await first.entered;
      const claiming = h.run(wsA, (r) => r.claim({ versionId: id }));
      await waitUntilBlocked(h, id);
      first.release();
      expect(await redriving).toEqual({ outcome: "redriven" });
      expect(await claiming).toEqual({ leaseGeneration: 1, attempt: 1 });
    } finally {
      first.release();
    }
    expect(await live(id)).toEqual([]);
    expect(await h.row(id)).toMatchObject({ status: "parsing", attempt: 1, lease_generation: 1 });
  });
});
