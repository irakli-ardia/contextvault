import { loadWorkerDatabaseEnv } from "@contextvault/config";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { derivedCounts, documentRow, seedDoc } from "../../testing/deletion-test-support";
import { createIngestionHarness } from "../../testing/ingestion-test-support";
import { deletedDoc, hour, purgedAt } from "../../testing/purge-test-support";
import { sqlState } from "../../testing/tenant-fixture";
import { openRolePools, ROLES, scalar } from "./role-test-support";

// Negative tests for migration 0018: what the worker role and the application role can NOT do to
// documents, chunks and sections, through the real policies. Grants are pinned in
// catalog-expected-grants; this proves behaviour.
const h = await createIngestionHarness();
const pools = openRolePools();
const { wsA, wsB } = h;
const worker = new pg.Pool({
  connectionString: loadWorkerDatabaseEnv().DATABASE_WORKER_URL,
  max: 2,
});
afterAll(async () => {
  await worker.end();
  await pools.close();
  await h.close();
});

const DENIED = "42501";
type Query = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;

/** The worker in one transaction that is always rolled back; `workspaceId` null asserts none. */
async function asWorker<T>(workspaceId: string | null, work: (q: Query) => Promise<T>): Promise<T> {
  const client = await worker.connect();
  try {
    await client.query("begin");
    if (workspaceId !== null)
      await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    return await work((text, values) => client.query(text, values));
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}
const code = async (workspaceId: string | null, text: string, values: unknown[] = []) =>
  asWorker(workspaceId, (q) => sqlState(q(text, values)));
const rows = async (workspaceId: string | null, text: string, values: unknown[] = []) =>
  asWorker(workspaceId, async (q) => (await q(text, values)).rowCount);

const mark = "update documents set purged_at = now() where id = $1";
const dropChunks = "delete from chunks where version_id = $1";
const dropSections = "delete from sections where version_id = $1";

describe("worker privileges", () => {
  it.each(["documents", "document_versions", "outbox", "memberships", "users"])(
    "holds no DELETE on %s",
    async (table) => {
      expect(
        await scalar<boolean>(
          pools.bootstrap,
          "select has_table_privilege($1, $2, 'DELETE') as v",
          [ROLES.worker, `public.${table}`],
        ),
      ).toBe(false);
    },
  );

  it("reads no tombstone metadata or chunk text", async () => {
    for (const [table, column] of [
      ["documents", "display_name"],
      ["documents", "content_sha256"],
      ["document_versions", "storage_key"],
      ["chunks", "content"],
      ["sections", "id"],
    ]) {
      expect(await code(null, `select ${column} from ${table} limit 1`), `${table}.${column}`).toBe(
        DENIED,
      );
    }
  });

  it("cannot UPDATE chunks or sections", async () => {
    expect(await code(wsA, "update chunks set ordinal = ordinal")).toBe(DENIED);
    expect(await code(wsA, "update sections set ordinal = ordinal")).toBe(DENIED);
  });
});

describe("discovery without a workspace", () => {
  it("sees deleted, unpurged documents and nothing else", async () => {
    const live = await seedDoc(h, wsA, "ready");
    const deleted = await deletedDoc(h, wsA);
    const purged = await deletedDoc(h, wsA);
    await h.fx.fixture.query("delete from chunks where version_id = $1", [purged.versionId]);
    await h.fx.fixture.query("update documents set purged_at = now() where id = $1", [
      purged.documentId,
    ]);

    const ids = await asWorker(null, async (q) =>
      (await q("select id from documents")).rows.map((r) => r.id),
    );
    expect(ids).toContain(deleted.documentId);
    expect(ids).not.toContain(live.documentId);
    expect(ids).not.toContain(purged.documentId);
  });

  it("sees no chunks, sections or versions' storage rows of a deleted document", async () => {
    const doc = await deletedDoc(h, wsA);
    expect(
      await rows(null, "select version_id from chunks where version_id = $1", [doc.versionId]),
    ).toBe(0);
    expect(
      await rows(null, "select version_id from sections where version_id = $1", [doc.versionId]),
    ).toBe(0);
  });
});

describe("deleting derived rows", () => {
  it("is refused (no row) for a live document", async () => {
    const live = await seedDoc(h, wsA, "ready");
    expect(await rows(wsA, dropChunks, [live.versionId])).toBe(0);
    expect(await rows(wsA, dropSections, [live.versionId])).toBe(0);
    expect(await derivedCounts(h, live.versionId)).toEqual({ sections: 1, chunks: 1 });
  });

  it("is refused for a deleted document of another workspace, and with no workspace", async () => {
    const doc = await deletedDoc(h, wsA);
    expect(await rows(wsB, dropChunks, [doc.versionId])).toBe(0);
    expect(await rows(null, dropChunks, [doc.versionId])).toBe(0);
    expect(await rows(wsB, dropSections, [doc.versionId])).toBe(0);
    expect(await derivedCounts(h, doc.versionId)).toEqual({ sections: 1, chunks: 1 });
  });

  it("works for a deleted document inside its own workspace", async () => {
    const doc = await deletedDoc(h, wsA);
    expect(await rows(wsA, dropChunks, [doc.versionId])).toBe(1);
    expect(await rows(wsA, dropSections, [doc.versionId])).toBe(1);
  });

  it("is refused for a purged tombstone", async () => {
    const doc = await deletedDoc(h, wsA);
    await h.fx.fixture.query("update documents set purged_at = now() where id = $1", [
      doc.documentId,
    ]);
    expect(await rows(wsA, dropChunks, [doc.versionId])).toBe(0);
    expect(await rows(wsA, dropSections, [doc.versionId])).toBe(0);
  });
});

describe("marking a document purged", () => {
  it("is refused for a live document (policy or CHECK, never a silent success)", async () => {
    const live = await seedDoc(h, wsA, "ready");
    expect(["42501", "23514"]).toContain(await code(wsA, mark, [live.documentId]));
  });

  it("is refused while chunks remain", async () => {
    const doc = await deletedDoc(h, wsA);
    expect(await code(wsA, mark, [doc.documentId])).toBe(DENIED);
    expect(await purgedAt(h, doc.documentId)).toBeNull();
  });

  it("is refused while a version is still waiting or running", async () => {
    const doc = await deletedDoc(h, wsA);
    await h.fx.fixture.query("delete from chunks where version_id = $1", [doc.versionId]);
    await h.fx.fixture.query("update document_versions set status = 'chunking' where id = $1", [
      doc.versionId,
    ]);
    expect(await code(wsA, mark, [doc.documentId])).toBe(DENIED);
  });

  it("is refused in another workspace and with none", async () => {
    const doc = await deletedDoc(h, wsA);
    await h.fx.fixture.query("delete from chunks where version_id = $1", [doc.versionId]);
    expect(await rows(wsB, mark, [doc.documentId])).toBe(0);
    expect(await rows(null, mark, [doc.documentId])).toBe(0);
  });

  it("succeeds once nothing is left, and the tombstone then cannot change again", async () => {
    const doc = await deletedDoc(h, wsA);
    await h.fx.fixture.query("delete from chunks where version_id = $1", [doc.versionId]);
    expect(await rows(wsA, mark, [doc.documentId])).toBe(1);
    await h.fx.fixture.query("update documents set purged_at = now() where id = $1", [
      doc.documentId,
    ]);
    expect(await rows(wsA, mark, [doc.documentId])).toBe(0);
    expect(
      await rows(wsA, "update documents set purged_at = null where id = $1", [doc.documentId]),
    ).toBe(0);
    expect(
      await rows(wsA, "update documents set active_version_id = $2 where id = $1", [
        doc.documentId,
        doc.versionId,
      ]),
    ).toBe(0);
  });

  it("cannot be done by the database for a live document (CHECK)", async () => {
    const live = await seedDoc(h, wsA, "ready");
    expect(await sqlState(h.fx.fixture.query(mark, [live.documentId]))).toBe("23514");
  });

  it("is not available to the application role", async () => {
    const doc = await deletedDoc(h, wsA, hour);
    expect(await sqlState(pools.app.query(mark, [doc.documentId]))).toBe(DENIED);
    expect(await sqlState(pools.app.query(dropChunks, [doc.versionId]))).toBe(DENIED);
    expect(await sqlState(pools.app.query(dropSections, [doc.versionId]))).toBe(DENIED);
    expect(await documentRow(h, doc.documentId)).toMatchObject({ active_version_id: null });
  });
});
