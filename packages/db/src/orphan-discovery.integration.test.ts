import {
  type DocumentVersionId,
  maxAttempts,
  type OrphanCandidate,
  orphanPageLimit,
  type VersionStatus,
} from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { hour, lockOrphan, seedOrphan } from "./orphan-test-support";
import { createIngestionHarness } from "./testing/ingestion-test-support";

// OrphanSource.listWaiting through the worker role against real PostgreSQL. Other tests' rows share
// the database, so each case scans every page and looks only at the ids it seeded.
const h = await createIngestionHarness();
const { wsA, wsB } = h;
const source = h.worker.orphanSource;
const day = 24 * hour;

afterAll(() => h.close());

async function scan(pageSize = orphanPageLimit): Promise<OrphanCandidate[]> {
  const found: OrphanCandidate[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await source.listWaiting(pageSize, after);
    found.push(...page.filter((c) => c.workspaceId === wsA || c.workspaceId === wsB));
    const last = page.at(-1);
    if (last === undefined) return found;
    after = last.cursor;
  }
}
const listed = async (id: DocumentVersionId, pageSize?: number) =>
  (await scan(pageSize)).some((c) => c.versionId === id);
const setUpdated = (id: DocumentVersionId, sql: string) =>
  h.fx.fixture.query(`update document_versions set updated_at = ${sql} where id = $1`, [id]);

describe("eligibility", () => {
  it.each(["uploaded", "queued"] as const)("lists an idle %s version", async (status) => {
    const id = await seedOrphan(h, wsB, { status });
    expect((await scan()).find((c) => c.versionId === id)).toMatchObject({ workspaceId: wsB });
  });

  it("excludes live outbox rows, due or future-scheduled, however old the version", async () => {
    const due = await h.seed(wsA, { status: "queued" });
    const future = await h.seed(wsA, { status: "queued", outboxDelayMs: 6 * hour });
    await setUpdated(due, `now() - interval '30 days'`);
    await setUpdated(future, `now() - interval '30 days'`);
    expect(await listed(due)).toBe(false);
    expect(await listed(future)).toBe(false);
  });

  it("excludes a version with history and one live row", async () => {
    const id = await seedOrphan(h, wsA, {
      history: [{ createdAgoMs: 9 * day, dispatchedAgoMs: 8 * day }],
    });
    await h.fx.fixture.query(
      `insert into outbox (id, workspace_id, version_id, kind, available_at)
       values (gen_random_uuid(), $1, $2, 'process_version', now())`,
      [wsA, id],
    );
    expect(await listed(id)).toBe(false);
  });

  it.each([
    "parsing",
    "chunking",
    "processed",
    "failed",
  ] as const satisfies readonly VersionStatus[])("excludes a %s version", async (status) => {
    expect(await listed(await seedOrphan(h, wsA, { status }))).toBe(false);
  });

  it("excludes exhausted attempts and lists the last attempt left", async () => {
    const spent = await seedOrphan(h, wsA, { attempt: maxAttempts });
    const last = await seedOrphan(h, wsA, { attempt: maxAttempts - 1 });
    expect(await listed(spent)).toBe(false);
    expect(await listed(last)).toBe(true);
  });
});

describe("pagination", () => {
  it("rejects limits outside 1..orphanPageLimit", async () => {
    for (const limit of [0, -1, 1.5, Number.NaN, orphanPageLimit + 1]) {
      await expect(source.listWaiting(limit)).rejects.toThrow(RangeError);
    }
  });

  it("pages oldest first across workspaces with ties broken by id, no duplicates or gaps", async () => {
    const tied: DocumentVersionId[] = [];
    for (let i = 0; i < 5; i++) tied.push(await seedOrphan(h, i % 2 === 0 ? wsA : wsB));
    const early = await seedOrphan(h, wsB);
    const late = await seedOrphan(h, wsA);
    // Five share one timestamp, so only the id orders them; one sits before it, one after.
    for (const id of tied) await setUpdated(id, `timestamptz '2001-01-01 00:00:00+00'`);
    await setUpdated(early, `timestamptz '2000-01-01 00:00:00+00'`);
    await setUpdated(late, `timestamptz '2002-01-01 00:00:00+00'`);

    const whole = (await scan()).map((c) => c.versionId);
    for (const pageSize of [1, 2, 3]) {
      const paged = (await scan(pageSize)).map((c) => c.versionId);
      expect(paged).toEqual(whole);
      expect(new Set(paged).size).toBe(paged.length);
    }
    const mine = whole.filter((id) => id === early || id === late || tied.includes(id));
    expect(mine).toEqual([early, ...[...tied].sort((a, b) => (a < b ? -1 : 1)), late]);
  });

  it("keeps microseconds in the cursor and never re-lists the row it came from", async () => {
    const a = await seedOrphan(h, wsA);
    const b = await seedOrphan(h, wsA);
    await setUpdated(a, `timestamptz '1999-06-01 00:00:00.123456+00'`);
    await setUpdated(b, `timestamptz '1999-06-01 00:00:00.123457+00'`);
    const page = await source.listWaiting(orphanPageLimit);
    const first = page.find((c) => c.versionId === a);
    expect(first?.cursor).toContain(".123456");
    const next = await source.listWaiting(orphanPageLimit, first?.cursor);
    expect(next.some((c) => c.versionId === a)).toBe(false);
    expect(next.some((c) => c.versionId === b)).toBe(true);
  });

  it("passes any number of older ineligible rows to find a later candidate", async () => {
    for (let i = 0; i < 12; i++) {
      const id = await h.seed(i % 2 === 0 ? wsA : wsB, { status: "queued" });
      await setUpdated(id, `timestamptz '1998-01-01 00:00:00+00'`);
    }
    const late = await seedOrphan(h, wsA);
    expect(await listed(late, 1)).toBe(true);
  });
});

describe("advisory results", () => {
  it("lists a deleted document's version, and lockOrphan refuses it", async () => {
    const id = await seedOrphan(h, wsA);
    await h.fx.fixture.query(
      `update documents set deleted_at = now()
       where id = (select document_id from document_versions where id = $1)`,
      [id],
    );
    expect(await listed(id)).toBe(true);
    expect(await lockOrphan(h, wsA, id)).toBeNull();
  });

  it("keeps scanning past old deleted-document candidates", async () => {
    for (let i = 0; i < 3; i++) {
      const id = await seedOrphan(h, wsA);
      await setUpdated(id, `timestamptz '1997-01-01 00:00:00+00'`);
      await h.fx.fixture.query(
        `update documents set deleted_at = now()
         where id = (select document_id from document_versions where id = $1)`,
        [id],
      );
    }
    const live = await seedOrphan(h, wsA);
    expect(await listed(live, 2)).toBe(true);
  });

  it("is rechecked by lockOrphan when eligibility changes after discovery", async () => {
    const gone = await seedOrphan(h, wsA);
    const claimed = await seedOrphan(h, wsA);
    const found = new Set((await scan()).map((c) => c.versionId));
    expect(found.has(gone) && found.has(claimed)).toBe(true);

    await h.fx.fixture.query(
      `insert into outbox (id, workspace_id, version_id, kind, available_at)
       values (gen_random_uuid(), $1, $2, 'process_version', now())`,
      [wsA, gone],
    );
    await h.fx.fixture.query("update document_versions set status = 'parsing' where id = $1", [
      claimed,
    ]);
    expect(await lockOrphan(h, wsA, gone)).toBeNull();
    expect(await lockOrphan(h, wsA, claimed)).toBeNull();
  });

  it("writes nothing", async () => {
    const id = await seedOrphan(h, wsA, {
      history: [{ createdAgoMs: 9 * day, dispatchedAgoMs: 8 * day }],
    });
    const count = async () =>
      (
        await h.fx.fixture.query(
          "select count(*)::int as n from outbox where workspace_id in ($1, $2)",
          [wsA, wsB],
        )
      ).rows[0].n;
    const before = { row: await h.row(id), outbox: await h.outboxRows(id), n: await count() };
    await scan(2);
    expect({ row: await h.row(id), outbox: await h.outboxRows(id), n: await count() }).toEqual(
      before,
    );
  });

  it("returns ids only", async () => {
    await seedOrphan(h, wsA);
    for (const c of await source.listWaiting(3)) {
      expect(Object.keys(c).sort()).toEqual(["cursor", "versionId", "workspaceId"]);
    }
  });
});
