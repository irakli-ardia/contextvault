import { randomUUID } from "node:crypto";
import { loadWorkerDatabaseEnv } from "@contextvault/config";
import type { WorkspaceId } from "@contextvault/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDocument, type Upload } from "../../testing/document-fixture";
import { createTenantFixture, sqlState } from "../../testing/tenant-fixture";

// The database-level fences of migration 0016, tried directly as the worker role (no repository):
// each test runs in one worker transaction that is always rolled back, so it needs no cleanup.
const fx = await createTenantFixture();
const worker = new pg.Pool({
  connectionString: loadWorkerDatabaseEnv().DATABASE_WORKER_URL,
  max: 2,
});
const DENIED = "42501";
const FK_VIOLATION = "23503";

let ws: WorkspaceId;
let v1: Upload; // version_no 1 of document D
let v2: string; // version_no 2 of the same document
let other: Upload; // a second document of the same workspace
let deleted: Upload; // a deleted document

beforeAll(async () => {
  const user = await fx.seedUser();
  ws = await fx.createWorkspace(user, "W");
  [v1, other, deleted] = await Promise.all([
    seedDocument(fx, ws, user, "d1"),
    seedDocument(fx, ws, user, "d2"),
    seedDocument(fx, ws, user, "d3"),
  ]);
  v2 = randomUUID();
  await fx.fixture.query(
    `insert into document_versions (id, document_id, workspace_id, version_no, storage_key)
     values ($1::uuid, $2::uuid, $3::uuid, 2, 'ws/' || $3::text || '/doc/' || $2::text || '/v/' || $1::text)`,
    [v2, v1.documentId, ws],
  );
  await fx.fixture.query("update documents set deleted_at = now() where id = $1", [
    deleted.documentId,
  ]);
});
afterAll(async () => {
  await worker.end();
  await fx.close();
});

type Query = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
async function asWorker<T>(work: (q: Query) => Promise<T>): Promise<T> {
  const client = await worker.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.workspace_id', $1, true)", [ws]);
    return await work((text, values) => client.query(text, values));
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

const setStatus = (q: Query, id: string, status: string) =>
  q("update document_versions set status = $2 where id = $1", [id, status]);
const section = (q: Query, versionId: string, id = randomUUID()) =>
  q(
    `insert into sections (id, workspace_id, version_id, ordinal, start_offset, end_offset)
     values ($1, $2, $3, 0, 0, 5)`,
    [id, ws, versionId],
  ).then(() => id);
const chunk = (q: Query, versionId: string, sectionId: string, ordinal = 0) =>
  q(
    `insert into chunks (id, workspace_id, version_id, section_id, strategy_id, strategy_version,
       ordinal, content, content_sha256, token_count, start_offset, end_offset)
     values ($1, $2, $3, $4, 'fixed-window', 1, $5, 'hello', $6, 1, 0, 5)`,
    [randomUUID(), ws, versionId, sectionId, ordinal, Buffer.alloc(32)],
  );
/** Gives the version one section and one chunk and makes it ready, as activation does. */
async function ready(q: Query, versionId: string) {
  await setStatus(q, versionId, "chunking");
  await chunk(q, versionId, await section(q, versionId));
  await setStatus(q, versionId, "ready");
}
const point = (q: Query, documentId: string, versionId: string | null) =>
  q("update documents set active_version_id = $2 where id = $1", [documentId, versionId]);

describe("ready needs chunks", () => {
  it("refuses ready for a version without chunks, from any state", async () => {
    for (const from of ["uploaded", "chunking", "failed"]) {
      expect(
        await sqlState(
          asWorker(async (q) => {
            await setStatus(q, v1.versionId, from);
            await setStatus(q, v1.versionId, "ready");
          }),
        ),
      ).toBe(DENIED);
    }
  });

  it("allows ready once the version holds a chunk", async () => {
    expect(await sqlState(asWorker((q) => ready(q, v1.versionId)))).toBeUndefined();
  });
});

describe("derived rows only while chunking", () => {
  it.each(["uploaded", "parsing", "failed", "ready"])(
    "refuses a section in a %s version",
    async (state) => {
      expect(
        await sqlState(
          asWorker(async (q) => {
            if (state === "ready") await ready(q, v1.versionId);
            else await setStatus(q, v1.versionId, state);
            await section(q, v1.versionId);
          }),
        ),
      ).toBe(DENIED);
    },
  );

  it("refuses a chunk added to an already ready (live) version", async () => {
    expect(
      await sqlState(
        asWorker(async (q) => {
          await setStatus(q, v1.versionId, "chunking");
          const s = await section(q, v1.versionId);
          await chunk(q, v1.versionId, s);
          await setStatus(q, v1.versionId, "ready");
          await chunk(q, v1.versionId, s, 1);
        }),
      ),
    ).toBe(DENIED);
  });

  it("refuses a chunk whose section belongs to another version of the same workspace", async () => {
    expect(
      await sqlState(
        asWorker(async (q) => {
          await setStatus(q, v1.versionId, "chunking");
          await setStatus(q, v2, "chunking");
          await chunk(q, v2, await section(q, v1.versionId));
        }),
      ),
    ).toBe(FK_VIOLATION);
  });
});

describe("workspace binding of derived rows", () => {
  it("refuses a section or chunk that names a version of another workspace", async () => {
    const user2 = await fx.seedUser();
    const ws2 = await fx.createWorkspace(user2, "W2");
    const foreign = await seedDocument(fx, ws2, user2, "d4");
    for (const sql of [
      `insert into sections (id, workspace_id, version_id, ordinal, start_offset, end_offset)
       values (gen_random_uuid(), '${ws}', '${foreign.versionId}', 0, 0, 1)`,
      `insert into sections (id, workspace_id, version_id, ordinal, start_offset, end_offset)
       values (gen_random_uuid(), '${ws2}', '${foreign.versionId}', 0, 0, 1)`,
    ]) {
      expect(
        await sqlState(
          asWorker(async (q) => {
            await setStatus(q, foreign.versionId, "chunking");
            await q(sql);
          }),
        ),
      ).toMatch(/^(42501|23503)$/);
    }
  });
});

describe("the active pointer", () => {
  it("points only at a ready version", async () => {
    expect(await sqlState(asWorker((q) => point(q, v1.documentId, v1.versionId)))).toBe(DENIED);
    expect(
      await sqlState(
        asWorker(async (q) => {
          await ready(q, v1.versionId);
          await point(q, v1.documentId, v1.versionId);
        }),
      ),
    ).toBeUndefined();
  });

  it("cannot be cleared, or pointed at another document's version", async () => {
    expect(await sqlState(asWorker((q) => point(q, v1.documentId, null)))).toBe(DENIED);
    expect(
      await sqlState(
        asWorker(async (q) => {
          await ready(q, other.versionId);
          await point(q, v1.documentId, other.versionId);
        }),
      ),
    ).toBe(DENIED);
  });

  it("never names a version when a newer ready version exists", async () => {
    expect(
      await sqlState(
        asWorker(async (q) => {
          await ready(q, v2);
          await ready(q, v1.versionId);
          await point(q, v1.documentId, v1.versionId);
        }),
      ),
    ).toBe(DENIED);
    expect(
      await sqlState(
        asWorker(async (q) => {
          await ready(q, v1.versionId);
          await ready(q, v2);
          await point(q, v1.documentId, v2);
        }),
      ),
    ).toBeUndefined();
  });

  it("cannot be set on a deleted document", async () => {
    expect(
      await sqlState(
        asWorker(async (q) => {
          await ready(q, deleted.versionId);
          await point(q, deleted.documentId, deleted.versionId);
        }),
      ),
    ).toBe(DENIED);
  });
});
