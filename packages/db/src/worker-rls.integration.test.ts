import { randomUUID } from "node:crypto";
import { loadWorkerDatabaseEnv } from "@contextvault/config";
import type { WorkspaceId } from "@contextvault/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDocument, type Upload } from "./document-fixture";
import { createTenantFixture, sqlState } from "./tenant-fixture";

// The ingestion worker role (NOBYPASSRLS, no user): it may discover lifecycle metadata in every
// workspace, but every write and every read of document data is bound to the one workspace its
// unit of work asserts. Grants and policy shape are in catalog-invariants; this proves behaviour.
const fx = await createTenantFixture();
const worker = new pg.Pool({
  connectionString: loadWorkerDatabaseEnv().DATABASE_WORKER_URL,
  max: 2,
});

const DENIED = "42501";
let wsA: WorkspaceId;
let wsB: WorkspaceId;
let docA: Upload;
let docB: Upload;
const outboxB = randomUUID();

beforeAll(async () => {
  const [u1, u2] = await Promise.all([fx.seedUser(), fx.seedUser()]);
  wsA = await fx.createWorkspace(u1, "A");
  wsB = await fx.createWorkspace(u2, "B");
  docA = await seedDocument(fx, wsA, u1);
  docB = await seedDocument(fx, wsB, u2);
  // Uploads write an outbox entry; these tests need B's row with a known id and nobody else's.
  await fx.fixture.query("delete from outbox where workspace_id = any($1::uuid[])", [[wsA, wsB]]);
  await fx.fixture.query(insert(outboxB, wsB, docB.versionId));
});
afterAll(async () => {
  await fx.fixture.query("delete from outbox where id = $1", [outboxB]);
  await worker.end();
  await fx.close();
});

type Query = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;

/** Runs `work` as the worker in one transaction that is always rolled back. */
async function asWorker<T>(workspaceId: string | null, work: (q: Query) => Promise<T>): Promise<T> {
  const client = await worker.connect();
  try {
    await client.query("begin");
    if (workspaceId !== null) {
      await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    }
    return await work((text, values) => client.query(text, values));
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

const insert = (id: string, workspaceId: string, versionId: string, availableAt = "now()") =>
  `insert into outbox (id, workspace_id, version_id, kind, available_at)
   values ('${id}', '${workspaceId}', '${versionId}', 'process_version', ${availableAt})`;

const advance = (versionId: string, status: string) =>
  `update document_versions set status = '${status}', lease_generation = lease_generation + 1,
   updated_at = now() where id = '${versionId}'`;

describe("role", () => {
  it("is unprivileged and holds no membership", async () => {
    const { rows } = await worker.query(
      `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
         exists (select 1 from pg_auth_members where member = r.oid) as member
       from pg_roles r where rolname = current_user`,
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      member: false,
    });
  });
});

describe("cross-workspace discovery", () => {
  it("sees lifecycle metadata of every workspace without any context", async () => {
    const ids = await asWorker(null, async (q) => {
      const { rows } = await q("select id from document_versions where id = any($1)", [
        [docA.versionId, docB.versionId],
      ]);
      return rows.map((r) => r.id);
    });
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining([docA.versionId, docB.versionId]));
  });

  it.each(["storage_key", "error_code", "version_no"])(
    "cannot read document_versions.%s",
    async (column) => {
      expect(
        await sqlState(asWorker(null, (q) => q(`select ${column} from document_versions`))),
      ).toBe(DENIED);
    },
  );

  it.each(["workspaces", "memberships", "users", "pending_uploads", "sessions"])(
    "cannot read %s",
    async (table) => {
      expect(await sqlState(asWorker(wsA, (q) => q(`select 1 from ${table}`)))).toBe(DENIED);
    },
  );

  it("reads documents only inside the asserted workspace, and only deleted_at", async () => {
    const seen = (ws: string | null) =>
      asWorker(ws, async (q) => (await q("select id from documents")).rows.map((r) => r.id));
    expect(await seen(wsA)).toEqual([docA.documentId]);
    expect(await seen(null)).toEqual([]);
    expect(await sqlState(asWorker(wsA, (q) => q("select display_name from documents")))).toBe(
      DENIED,
    );
  });
});

describe("version writes are tenant-scoped", () => {
  it("updates a version of the asserted workspace to processed", async () => {
    const status = await asWorker(wsA, async (q) => {
      expect((await q(advance(docA.versionId, "processed"))).rowCount).toBe(1);
      return (await q("select status from document_versions where id = $1", [docA.versionId]))
        .rows[0]?.status;
    });
    expect(status).toBe("processed");
  });

  it("changes nothing in another workspace's version", async () => {
    expect((await asWorker(wsA, (q) => q(advance(docB.versionId, "parsing")))).rowCount).toBe(0);
  });

  it("changes nothing without context", async () => {
    expect((await asWorker(null, (q) => q(advance(docA.versionId, "parsing")))).rowCount).toBe(0);
  });

  it("cannot mark a version ready (only the M1.6 activation may)", async () => {
    expect(await sqlState(asWorker(wsA, (q) => q(advance(docA.versionId, "ready"))))).toBe(DENIED);
  });

  it.each([
    [
      "move a version to another workspace",
      () => `update document_versions set workspace_id = '${wsB}' where id = '${docA.versionId}'`,
    ],
    [
      "rewrite its storage key",
      () => `update document_versions set storage_key = 'x' where id = '${docA.versionId}'`,
    ],
    ["delete it", () => `delete from document_versions where id = '${docA.versionId}'`],
    [
      "insert one",
      () =>
        `insert into document_versions (id, document_id, workspace_id, version_no, storage_key) values ('${randomUUID()}', '${docA.documentId}', '${wsA}', 9, 'x')`,
    ],
    [
      "delete-mark a document",
      () => `update documents set deleted_at = now() where id = '${docA.documentId}'`,
    ],
  ])("cannot %s", async (_name, statement) => {
    expect(await sqlState(asWorker(wsA, (q) => q(statement())))).toBe(DENIED);
  });
});

describe("outbox", () => {
  it("inserts and marks inside the asserted workspace", async () => {
    const id = randomUUID();
    const marked = await asWorker(wsA, async (q) => {
      await q(insert(id, wsA, docA.versionId));
      return (await q("update outbox set dispatched_at = now() where id = $1", [id])).rowCount;
    });
    expect(marked).toBe(1);
  });

  it("discovers another workspace's row but cannot mark it", async () => {
    const { seen, marked } = await asWorker(wsA, async (q) => ({
      seen: (await q("select id from outbox where id = $1", [outboxB])).rowCount,
      marked: (await q("update outbox set dispatched_at = now() where id = $1", [outboxB]))
        .rowCount,
    }));
    expect(seen).toBe(1);
    expect(marked).toBe(0);
  });

  it("cannot insert for another workspace or without context", async () => {
    const forB = insert(randomUUID(), wsB, docB.versionId);
    expect(await sqlState(asWorker(wsA, (q) => q(forB)))).toBe(DENIED);
    expect(await sqlState(asWorker(null, (q) => q(forB)))).toBe(DENIED);
  });

  it("can change only dispatched_at and available_at, and cannot delete", async () => {
    const id = randomUUID();
    const seed = (q: Query) => q(insert(id, wsA, docA.versionId));
    for (const statement of [
      "update outbox set created_at = now()",
      "update outbox set workspace_id = workspace_id",
      "delete from outbox",
    ]) {
      expect(
        await sqlState(
          asWorker(wsA, async (q) => {
            await seed(q);
            await q(statement);
          }),
        ),
        statement,
      ).toBe(DENIED);
    }
  });

  it("allows one undispatched row per version, and another once it is dispatched", async () => {
    const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
    expect(
      await sqlState(
        asWorker(wsA, async (q) => {
          await q(insert(first, wsA, docA.versionId));
          await q(insert(second, wsA, docA.versionId));
        }),
      ),
    ).toBe("23505");
    const count = await asWorker(wsA, async (q) => {
      await q(insert(first, wsA, docA.versionId));
      await q("update outbox set dispatched_at = now() where id = $1", [first]);
      await q(insert(third, wsA, docA.versionId, "now() + interval '30 seconds'"));
      const { rows } = await q("select count(*)::int as n from outbox where version_id = $1", [
        docA.versionId,
      ]);
      return rows[0]?.n;
    });
    expect(count).toBe(2);
  });

  it("refuses a version of a different workspace (composite foreign key)", async () => {
    expect(await sqlState(asWorker(wsA, (q) => q(insert(randomUUID(), wsA, docB.versionId))))).toBe(
      "23503",
    );
  });
});
