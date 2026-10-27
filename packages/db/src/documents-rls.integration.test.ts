import { randomUUID } from "node:crypto";
import { type UserId, WorkspaceAccessDenied, type WorkspaceId } from "@contextvault/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  newUpload,
  reserveInput,
  roomy,
  seedDocument,
  sha256,
  type Upload,
} from "./document-fixture";
import { createTenantFixture, sqlState } from "./tenant-fixture";

const fx = createTenantFixture();
const run = fx.persistence.unitOfWork.run.bind(fx.persistence.unitOfWork);

// u1 owns A, u2 owns B, u3 belongs to both. Each workspace holds one document and one reservation.
let u1: UserId;
let u2: UserId;
let u3: UserId;
let wsA: WorkspaceId;
let wsB: WorkspaceId;
let docA: Upload;
let docB: Upload;
let pendingB: Upload;

beforeAll(async () => {
  [u1, u2, u3] = await Promise.all([fx.seedUser(), fx.seedUser(), fx.seedUser()]);
  wsA = await fx.createWorkspace(u1, "A");
  wsB = await fx.createWorkspace(u2, "B");
  await run({ userId: u1, workspaceId: wsA }, (r) => r.workspaces.addMember(wsA, u3, "member"));
  await run({ userId: u2, workspaceId: wsB }, (r) => r.workspaces.addMember(wsB, u3, "member"));
  docA = await seedDocument(fx, wsA, u1);
  docB = await seedDocument(fx, wsB, u2);
  pendingB = newUpload(wsB, u2);
  await run({ userId: u2, workspaceId: wsB }, (r) =>
    r.uploads.reserveUpload(reserveInput(pendingB), roomy),
  );
});
afterAll(() => fx.close());

const as = (userId: UserId, workspaceId: WorkspaceId) => ({ userId, workspaceId });
const tables = ["documents", "document_versions", "pending_uploads"] as const;

describe("reads", () => {
  it.each(tables)(
    "workspace A's context sees none of B's %s rows, even for a member of both",
    async (table) => {
      const rows = await fx.queryAs<{ workspace_id: string }>(
        as(u3, wsA),
        `select workspace_id from ${table}`,
      );
      expect(rows.length).toBeLessThanOrEqual(1);
      expect(rows.every((r) => r.workspace_id === wsA)).toBe(true);
    },
  );

  it("repositories return only the context's workspace", async () => {
    const seen = await run(as(u3, wsA), async (r) => ({
      own: await r.documents.findById(wsA, docA.documentId),
      foreign: await r.documents.findById(wsB, docB.documentId),
      foreignInOwn: await r.documents.findById(wsA, docB.documentId),
      listedB: await r.documents.list(wsB, 50),
      pendingB: await r.uploads.listPendingUploads(wsB, new Date(Date.now() + 1000), 10),
    }));
    expect(seen.own?.id).toBe(docA.documentId);
    expect(seen.foreign).toBeNull();
    expect(seen.foreignInOwn).toBeNull();
    expect(seen.listedB).toEqual([]);
    expect(seen.pendingB).toEqual([]);
  });

  it("a join cannot reach across workspaces", async () => {
    const rows = await fx.queryAs<{ workspace_id: string }>(
      as(u3, wsA),
      `select d.workspace_id from documents d join document_versions v on v.document_id = d.id
       union all select p.workspace_id from pending_uploads p join documents d on d.workspace_id = p.workspace_id`,
    );
    expect(rows.every((r) => r.workspace_id === wsA)).toBe(true);
  });
});

describe("fail closed", () => {
  it.each([
    ["no context", () => null],
    ["user without workspace", () => ({ userId: u1 })],
    ["workspace without user", () => ({ workspaceId: wsA })],
    ["empty strings", () => ({ userId: "", workspaceId: "" })],
    ["workspace the user does not belong to", () => ({ userId: u1, workspaceId: wsB })],
  ])("returns nothing with %s", async (_name, context) => {
    // Built lazily: the ids exist only after beforeAll.
    for (const table of tables) {
      expect(await fx.queryAs(context(), `select 1 from ${table}`)).toEqual([]);
    }
  });

  it("refuses inserts without a valid context", async () => {
    const id = randomUUID();
    const state = sqlState(
      fx.queryAs(
        { userId: u1 },
        `insert into pending_uploads (id, workspace_id, storage_key, declared_bytes, created_by)
         values ($1, $2, $3, 1, $4)`,
        [id, wsA, `ws/${wsA}/doc/${randomUUID()}/v/${id}`, u1],
      ),
    );
    expect(await state).toBe("42501");
  });

  it("refuses document and version inserts without a workspace in context", async () => {
    const id = randomUUID();
    const version = fx.queryAs(
      { userId: u1 },
      `insert into document_versions (id, document_id, workspace_id, version_no, storage_key)
       values ($1, $2, $3, 2, $4)`,
      [id, docA.documentId, wsA, `ws/${wsA}/doc/${docA.documentId}/v/${id}`],
    );
    expect(await sqlState(version)).toBe("42501");
    const document = fx.queryAs(
      { userId: u1 },
      `insert into documents (id, workspace_id, display_name, mime, size_bytes, content_sha256, created_by)
       values (gen_random_uuid(), $1, 'x.pdf', 'application/pdf', 1, $2, $3)`,
      [wsA, sha256(randomUUID()), u1],
    );
    expect(await sqlState(document)).toBe("42501");
  });

  it("a malformed workspace id errors instead of matching", async () => {
    expect(
      await sqlState(fx.queryAs({ userId: u1, workspaceId: "nope" }, "select 1 from documents")),
    ).toBe("22P02");
  });

  it("the unit of work refuses a workspace the user is not a member of", async () => {
    await expect(run(as(u1, wsB), async () => 1)).rejects.toBeInstanceOf(WorkspaceAccessDenied);
  });

  it("loses access when the membership is revoked", async () => {
    const user = await fx.seedUser();
    const ws = await fx.createWorkspace(user, "Revocable");
    const doc = await seedDocument(fx, ws, user);
    expect(await run(as(user, ws), (r) => r.documents.findById(ws, doc.documentId))).not.toBeNull();
    await fx.owner.query("delete from memberships where workspace_id = $1", [ws]);
    expect(await fx.queryAs(as(user, ws), "select 1 from documents")).toEqual([]);
    await expect(run(as(user, ws), async () => 1)).rejects.toBeInstanceOf(WorkspaceAccessDenied);
  });
});

describe("writes", () => {
  const document = (workspaceId: string, createdBy: string): [string, unknown[]] => [
    `insert into documents (id, workspace_id, display_name, mime, size_bytes, content_sha256, created_by)
     values (gen_random_uuid(), $1, 'x.pdf', 'application/pdf', 1, $2, $3)`,
    [workspaceId, sha256(randomUUID()), createdBy],
  ];

  it("cannot create metadata under another workspace", async () => {
    expect(await sqlState(fx.queryAs(as(u3, wsA), ...document(wsB, u3)))).toBe("42501");
    expect(await sqlState(fx.queryAs(as(u1, wsA), ...document(wsB, u1)))).toBe("42501");
  });

  it("cannot create metadata in its own workspace on someone else's behalf", async () => {
    expect(await sqlState(fx.queryAs(as(u3, wsA), ...document(wsA, u1)))).toBe("42501");
  });

  it("cannot attach a version to a document of another workspace", async () => {
    const insert = (workspaceId: string, documentId: string, ctx: WorkspaceId) => {
      const id = randomUUID();
      return fx.queryAs(
        as(u3, ctx),
        `insert into document_versions (id, document_id, workspace_id, version_no, storage_key)
         values ($1, $2, $3, 2, $4)`,
        [id, documentId, workspaceId, `ws/${workspaceId}/doc/${documentId}/v/${id}`],
      );
    };
    // Named workspace is foreign: the policy refuses. Named workspace is the context's but the
    // document is foreign: the composite foreign key refuses, even though FK checks skip RLS.
    expect(await sqlState(insert(wsB, docB.documentId, wsA))).toBe("42501");
    expect(await sqlState(insert(wsA, docB.documentId, wsA))).toBe("23503");
  });

  it("cannot reserve under another workspace or for another user", async () => {
    const insert = (workspaceId: WorkspaceId, createdBy: UserId) => {
      const id = randomUUID();
      return fx.queryAs(
        as(u3, wsA),
        `insert into pending_uploads (id, workspace_id, storage_key, declared_bytes, created_by)
         values ($1, $2, $3, 1, $4)`,
        [id, workspaceId, `ws/${workspaceId}/doc/${randomUUID()}/v/${id}`, createdBy],
      );
    };
    expect(await sqlState(insert(wsB, u3))).toBe("42501");
    expect(await sqlState(insert(wsA, u1))).toBe("42501");
  });

  it.each([
    ["update documents", "update documents set display_name = 'x'"],
    ["delete documents", "delete from documents"],
    ["update document_versions", "update document_versions set status = 'ready'"],
    ["delete document_versions", "delete from document_versions"],
    ["update pending_uploads", "update pending_uploads set declared_bytes = 1"],
    ["truncate documents", "truncate documents"],
  ])("cannot %s", async (_name, statement) => {
    expect(await sqlState(fx.queryAs(as(u1, wsA), statement))).toBe("42501");
  });

  it("cannot delete another workspace's or another member's reservation", async () => {
    const mine = newUpload(wsB, u3);
    await run(as(u3, wsB), (r) => r.uploads.reserveUpload(reserveInput(mine), roomy));
    const gone = (ctx: ReturnType<typeof as>, id: string) =>
      fx.queryAs(ctx, "delete from pending_uploads where id = $1 returning id", [id]);
    expect(await gone(as(u3, wsA), pendingB.versionId)).toEqual([]);
    expect(await gone(as(u3, wsB), pendingB.versionId)).toEqual([]); // u2's, not u3's
    expect(await gone(as(u3, wsB), mine.versionId)).toHaveLength(1);
  });
});
