import { randomUUID } from "node:crypto";
import {
  maxAttempts,
  type OrphanSnapshot,
  parseDocumentVersionId,
  redriveCooldownMs,
  redriveOrphan,
  type VersionStatus,
} from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { expectIdle, hour, lockOrphan, minute, seedOrphan } from "./orphan-test-support";
import { createIngestionHarness } from "./testing/ingestion-test-support";

// OrphanRepository.lockOrphan through the worker role against real PostgreSQL.
const h = await createIngestionHarness();
const { wsA, wsB } = h;

afterAll(() => h.close());

const redrive = (versionId: Parameters<typeof lockOrphan>[2], ws = wsA) =>
  redriveOrphan(
    { uow: h.worker.orphanUnitOfWork, newId: randomUUID },
    { workspaceId: ws, versionId },
  );
const liveEntries = async (id: string) =>
  (await h.outboxRows(id)).filter((e) => e.dispatched_at === null);

describe("eligibility", () => {
  it.each(["uploaded", "queued"] as const)(
    "returns a snapshot for a %s version",
    async (status) => {
      const id = await seedOrphan(h, wsA, { status, attempt: 1 });
      expect(await lockOrphan(h, wsA, id)).toMatchObject({ status, attempt: 1, outboxRows: 0 });
    },
  );

  it("returns null for a live due entry", async () => {
    const id = await h.seed(wsA, { status: "queued" });
    expect(await lockOrphan(h, wsA, id)).toBeNull();
  });

  it("returns null for a live future-scheduled entry", async () => {
    const id = await h.seed(wsA, { status: "queued", outboxDelayMs: 6 * hour });
    expect(await lockOrphan(h, wsA, id)).toBeNull();
  });

  it("returns null for a deleted parent document", async () => {
    const id = await seedOrphan(h, wsA);
    await h.fx.fixture.query(
      `update documents set deleted_at = now()
       where id = (select document_id from document_versions where id = $1)`,
      [id],
    );
    expect(await lockOrphan(h, wsA, id)).toBeNull();
  });

  it("returns null once business attempts are exhausted", async () => {
    const id = await seedOrphan(h, wsA, { attempt: maxAttempts });
    expect(await lockOrphan(h, wsA, id)).toBeNull();
    expect(
      await lockOrphan(h, wsA, await seedOrphan(h, wsA, { attempt: maxAttempts - 1 })),
    ).not.toBeNull();
  });

  it.each([
    "parsing",
    "chunking",
    "processed",
    "failed",
  ] as const satisfies readonly VersionStatus[])(
    "returns null for a %s version",
    async (status) => {
      const id = await seedOrphan(h, wsA, { status });
      expect(await lockOrphan(h, wsA, id)).toBeNull();
    },
  );

  it("returns null for a missing version and for another workspace's version", async () => {
    const other = await seedOrphan(h, wsB);
    expect(await lockOrphan(h, wsA, other)).toBeNull();
    expect(await lockOrphan(h, wsB, other)).not.toBeNull();
    expect(await lockOrphan(h, wsA, parseDocumentVersionId(randomUUID()))).toBeNull();
  });
});

describe("outbox history and idle time", () => {
  it("uses updated_at when there is no history", async () => {
    const id = await seedOrphan(h, wsA, { updatedAgoMs: 2 * hour });
    expectIdle(await lockOrphan(h, wsA, id), 2 * hour);
  });

  it("uses updated_at when it is later than the latest dispatch", async () => {
    const id = await seedOrphan(h, wsA, {
      updatedAgoMs: hour,
      history: [{ createdAgoMs: 9 * hour, dispatchedAgoMs: 8 * hour }],
    });
    const snapshot = await lockOrphan(h, wsA, id);
    expectIdle(snapshot, hour);
    expect(snapshot?.outboxRows).toBe(1);
  });

  it("uses the latest dispatched_at when it is later than updated_at", async () => {
    const id = await seedOrphan(h, wsA, {
      updatedAgoMs: 10 * hour,
      history: [{ createdAgoMs: 9 * hour, dispatchedAgoMs: 30 * minute }],
    });
    expectIdle(await lockOrphan(h, wsA, id), 30 * minute);
  });

  it("takes the maximum dispatched_at even when created_at order disagrees", async () => {
    const id = await seedOrphan(h, wsA, {
      updatedAgoMs: 10 * hour,
      history: [
        { createdAgoMs: 8 * hour, dispatchedAgoMs: 2 * hour },
        { createdAgoMs: 5 * hour, dispatchedAgoMs: 4 * hour },
        { createdAgoMs: 3 * hour, dispatchedAgoMs: 3 * hour - minute },
      ],
    });
    const snapshot = await lockOrphan(h, wsA, id);
    expectIdle(snapshot, 2 * hour);
    expect(snapshot?.outboxRows).toBe(3);
  });

  it("caps the row count at the supplied cap and keeps the true maximum beyond it", async () => {
    // The oldest-created row holds the latest dispatch, far outside any last-N window.
    const history = Array.from({ length: 14 }, (_, i) => ({
      createdAgoMs: (30 - i) * hour,
      dispatchedAgoMs: (i === 0 ? 1 : 20 + i) * hour,
    }));
    const id = await seedOrphan(h, wsA, { updatedAgoMs: 40 * hour, history });
    const at = await lockOrphan(h, wsA, id, 11);
    expect(at?.outboxRows).toBe(11);
    expectIdle(at, hour);
    expect((await lockOrphan(h, wsA, id, 14))?.outboxRows).toBe(14);
    expect((await lockOrphan(h, wsA, id, 20))?.outboxRows).toBe(14);
  });

  it.each([
    { rows: 0, attempt: 0 },
    { rows: 1, attempt: 1 },
    { rows: 3, attempt: 1 },
    { rows: 5, attempt: 2 },
  ])("reports $rows rows at attempt $attempt", async ({ rows, attempt }) => {
    const history = Array.from({ length: rows }, (_, i) => ({
      createdAgoMs: (30 - i) * hour,
      dispatchedAgoMs: (29 - i) * hour,
    }));
    const id = await seedOrphan(h, wsA, { attempt, history });
    expect(await lockOrphan(h, wsA, id)).toMatchObject({ outboxRows: rows, attempt });
  });

  it("changes no version field", async () => {
    const id = await seedOrphan(h, wsA, { attempt: 2, updatedAgoMs: hour });
    const before = await h.row(id);
    await lockOrphan(h, wsA, id);
    expect(await h.row(id)).toEqual(before);
  });
});

describe("redrive cooldown against the database clock", () => {
  const snapshotFor = (s: OrphanSnapshot | null) => redriveCooldownMs(s?.outboxRows, s?.attempt);

  it("redrives at the cooldown boundary and skips below it", async () => {
    const cooldown = redriveCooldownMs(0, 0);
    const at = await seedOrphan(h, wsA, { updatedAgoMs: cooldown });
    expect(await redrive(at)).toEqual({ outcome: "redriven" });
    // A minute below: seeding-to-check latency on a slow runner only adds idle time, so it cannot
    // reach the boundary, and the version must still be skipped.
    const below = await seedOrphan(h, wsA, { updatedAgoMs: cooldown - minute });
    expect(await redrive(below)).toEqual({ outcome: "skipped" });
    expect(await liveEntries(below)).toEqual([]);
  });

  it("scales the cooldown with the history and attempt", async () => {
    const history = Array.from({ length: 4 }, (_, i) => ({
      createdAgoMs: (30 - i) * hour,
      dispatchedAgoMs: (29 - i) * hour,
    }));
    const id = await seedOrphan(h, wsA, { attempt: 1, updatedAgoMs: 40 * hour, history });
    const cooldown = snapshotFor(await lockOrphan(h, wsA, id));
    expect(cooldown).toBe(redriveCooldownMs(4, 1));
    // idle is 29 h since the latest dispatch: beyond every cooldown, so redriven.
    expect(await redrive(id)).toEqual({ outcome: "redriven" });
  });

  it("makes the new entry due immediately, then never a second live entry", async () => {
    const id = await seedOrphan(h, wsA, { updatedAgoMs: 24 * hour });
    expect(await redrive(id)).toEqual({ outcome: "redriven" });
    const [entry, ...others] = await liveEntries(id);
    expect(others).toEqual([]);
    expect(entry?.delay_ms).toBe(0);
    const { rows } = await h.fx.fixture.query<{ due: boolean }>(
      "select available_at <= now() as due from outbox where id = $1",
      [entry?.id],
    );
    expect(rows[0]?.due).toBe(true);
    expect(await redrive(id)).toEqual({ outcome: "skipped" });
    expect(await liveEntries(id)).toHaveLength(1);
  });

  it("leaves a pending retry backoff alone", async () => {
    const id = await h.seed(wsA, { status: "queued", attempt: 1, outboxDelayMs: 5_000 });
    const before = await h.outboxRows(id);
    expect(await redrive(id)).toEqual({ outcome: "skipped" });
    expect(await h.outboxRows(id)).toEqual(before);
    expect(await h.run(wsA, (r) => r.claim({ versionId: id }))).toBeNull();
  });
});
