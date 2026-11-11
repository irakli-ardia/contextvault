import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  type Api,
  createTenantFixture,
  loginAs,
  seedAccount,
  startApi,
  webOrigin,
} from "../../testing/test-support";

const fx = await createTenantFixture(4);
let api: Api;
let owner: { account: Account; token: string };
let admin: { account: Account; token: string };
let member: { account: Account; token: string };
let outsider: { account: Account; token: string };
let workspaceId: string;
let otherWorkspaceId: string;

const signIn = async (account: Account) => ({
  account,
  token: (await loginAs(api, account)).token,
});
const remove = (
  token: string | null,
  ws: string,
  documentId: string,
  origin: string | null = webOrigin,
) => {
  let req = api.http.delete(`/workspaces/${ws}/documents/${documentId}`);
  if (token !== null) req = req.set("Cookie", `cv_session=${token}`);
  if (origin !== null) req = req.set("Origin", origin);
  return req;
};

async function seedDoc(ws: string, by: Account) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  await fx.fixture.query(
    `insert into documents (id, workspace_id, display_name, mime, size_bytes, content_sha256, created_by)
     values ($1, $2, 'a.txt', 'text/plain', 1, $3, $4)`,
    [documentId, ws, Buffer.alloc(32, 1).fill(Math.floor(Math.random() * 255)), by.id],
  );
  await fx.fixture.query(
    `insert into document_versions (id, document_id, workspace_id, version_no, storage_key, status)
     values ($1, $2, $3, 1, $4, 'queued')`,
    [versionId, documentId, ws, `ws/${ws}/doc/${documentId}/v/${versionId}`],
  );
  return { documentId, versionId };
}
const state = async (documentId: string, versionId: string) => ({
  deleted:
    (await fx.fixture.query("select deleted_at from documents where id = $1", [documentId])).rows[0]
      .deleted_at !== null,
  status: (
    await fx.fixture.query("select status from document_versions where id = $1", [versionId])
  ).rows[0].status,
});

beforeAll(async () => {
  api = await startApi();
  const [a, b, c, d] = await Promise.all([
    seedAccount(fx),
    seedAccount(fx),
    seedAccount(fx),
    seedAccount(fx),
  ]);
  workspaceId = await fx.createWorkspace(a.id, "Docs");
  otherWorkspaceId = await fx.createWorkspace(d.id, "Other");
  await fx.fixture.query(
    "insert into memberships (workspace_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member')",
    [workspaceId, b.id, c.id],
  );
  [owner, admin, member, outsider] = await Promise.all([
    signIn(a),
    signIn(b),
    signIn(c),
    signIn(d),
  ]);
});
afterAll(async () => {
  await api.app.close();
  await fx.close();
});

describe("DELETE /workspaces/:workspaceId/documents/:documentId", () => {
  it.each(["owner", "admin"] as const)(
    "lets the %s delete, and a repeat answers 204 again",
    async (who) => {
      const user = who === "owner" ? owner : admin;
      const doc = await seedDoc(workspaceId, owner.account);
      expect((await remove(user.token, workspaceId, doc.documentId)).status).toBe(204);
      expect(await state(doc.documentId, doc.versionId)).toEqual({
        deleted: true,
        status: "failed",
      });
      expect((await remove(user.token, workspaceId, doc.documentId)).status).toBe(204);
    },
  );

  it("refuses a member with 403 and changes nothing", async () => {
    const doc = await seedDoc(workspaceId, owner.account);
    const res = await remove(member.token, workspaceId, doc.documentId);
    expect([res.status, res.body.error.code]).toEqual([403, "permission.denied"]);
    expect(await state(doc.documentId, doc.versionId)).toEqual({
      deleted: false,
      status: "queued",
    });
  });

  it("refuses an unauthenticated request and a wrong Origin", async () => {
    const doc = await seedDoc(workspaceId, owner.account);
    expect((await remove(null, workspaceId, doc.documentId)).status).toBe(401);
    expect((await remove(owner.token, workspaceId, doc.documentId, null)).status).toBe(403);
    expect(
      (await remove(owner.token, workspaceId, doc.documentId, "http://evil.example")).status,
    ).toBe(403);
    expect((await state(doc.documentId, doc.versionId)).deleted).toBe(false);
  });

  it("answers 404 for another workspace, a foreign document, an unknown and a malformed id", async () => {
    const foreign = await seedDoc(otherWorkspaceId, outsider.account);
    const cases: [string, string, string][] = [
      [owner.token, workspaceId, foreign.documentId], // document of another workspace
      [owner.token, otherWorkspaceId, foreign.documentId], // not a member of that workspace
      [owner.token, workspaceId, randomUUID()],
      [owner.token, workspaceId, "not-a-uuid"],
    ];
    for (const [token, ws, id] of cases) {
      const res = await remove(token, ws, id);
      expect([res.status, res.body.error.code], id).toEqual([404, "not_found"]);
    }
    expect(await state(foreign.documentId, foreign.versionId)).toEqual({
      deleted: false,
      status: "queued",
    });
  });
});
