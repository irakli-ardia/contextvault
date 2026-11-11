import { randomBytes, randomUUID } from "node:crypto";
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
import { MAX_RETRIES_PER_USER } from "../retry-limiter";

// Every request spends one slot of its user's retry allowance (accepted or refused), so each case
// signs in a fresh member instead of sharing one user.
const fx = await createTenantFixture(4);
let api: Api;
let workspaceId: string;
let otherWorkspaceId: string;
let outsider: { account: Account; token: string };

type Role = "owner" | "admin" | "member";

async function signIn(ws: string, role: Role) {
  const account = await seedAccount(fx);
  if (role !== "owner") {
    await fx.fixture.query(
      "insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)",
      [ws, account.id, role],
    );
  }
  return { account, token: (await loginAs(api, account)).token };
}
const retry = (
  token: string | null,
  ws: string,
  documentId: string,
  origin: string | null = webOrigin,
) => {
  let req = api.http.post(`/workspaces/${ws}/documents/${documentId}/retry`);
  if (token !== null) req = req.set("Cookie", `cv_session=${token}`);
  if (origin !== null) req = req.set("Origin", origin);
  return req;
};

async function seedDoc(
  ws: string,
  by: Account,
  version: { status: string; attempt?: number; code?: string | null; retryable?: boolean | null },
) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  await fx.fixture.query(
    `insert into documents (id, workspace_id, display_name, mime, size_bytes, content_sha256, created_by)
     values ($1, $2, 'a.txt', 'text/plain', 1, $3, $4)`,
    [documentId, ws, randomBytes(32), by.id],
  );
  await fx.fixture.query(
    `insert into document_versions
       (id, document_id, workspace_id, version_no, storage_key, status, attempt, lease_generation,
        error_stage, error_code, error_retryable)
     values ($1, $2, $3, 1, $4, $5, $6, 3, $7, $8, $9)`,
    [
      versionId,
      documentId,
      ws,
      `ws/${ws}/doc/${documentId}/v/${versionId}`,
      version.status,
      version.attempt ?? 0,
      version.status === "failed" ? "parsing" : null,
      version.code === undefined ? null : version.code,
      version.retryable === undefined ? null : version.retryable,
    ],
  );
  return { documentId, versionId };
}
const failed = (ws: string, by: Account) =>
  seedDoc(ws, by, {
    status: "failed",
    attempt: 3,
    code: "storage.unavailable",
    retryable: true,
  });
const state = async (versionId: string) => {
  const { rows } = await fx.fixture.query(
    `select status, attempt, lease_generation, error_code,
       (select count(*)::int from outbox where version_id = $1 and dispatched_at is null) as live
     from document_versions where id = $1`,
    [versionId],
  );
  return rows[0];
};

beforeAll(async () => {
  api = await startApi();
  const other = await seedAccount(fx);
  otherWorkspaceId = await fx.createWorkspace(other.id, "Other");
  outsider = { account: other, token: (await loginAs(api, other)).token };
  const owner = await seedAccount(fx);
  workspaceId = await fx.createWorkspace(owner.id, "Docs");
  ownerAccount = owner;
});
let ownerAccount: Account;
afterAll(async () => {
  await api.app.close();
  await fx.close();
});

describe("POST /workspaces/:workspaceId/documents/:documentId/retry", () => {
  it.each(["admin", "member"] as const)(
    "lets a workspace %s retry: 202, queued, one live entry, fresh budget",
    async (role) => {
      const user = await signIn(workspaceId, role);
      const doc = await failed(workspaceId, ownerAccount);
      const res = await retry(user.token, workspaceId, doc.documentId);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        id: doc.documentId,
        displayName: "a.txt",
        mime: "text/plain",
        sizeBytes: 1,
        status: "queued",
        error: null,
        createdAt: expect.any(String),
      });
      expect(await state(doc.versionId)).toMatchObject({
        status: "queued",
        attempt: 0,
        lease_generation: 4,
        error_code: null,
        live: 1,
      });
    },
  );

  it("lets the workspace owner retry too", async () => {
    const owner = await seedAccount(fx);
    const ws = await fx.createWorkspace(owner.id, "Owned");
    const token = (await loginAs(api, owner)).token;
    const doc = await failed(ws, owner);
    expect((await retry(token, ws, doc.documentId)).status).toBe(202);
  });

  it("answers a repeat with 409 and enqueues once", async () => {
    const user = await signIn(workspaceId, "member");
    const doc = await failed(workspaceId, ownerAccount);
    expect((await retry(user.token, workspaceId, doc.documentId)).status).toBe(202);
    const again = await retry(user.token, workspaceId, doc.documentId);
    expect([again.status, again.body.error.code]).toEqual([409, "document.not_retryable"]);
    expect(await state(doc.versionId)).toMatchObject({ status: "queued", live: 1 });
  });

  it.each([
    ["a non-retryable failure", { status: "failed", code: "parse.encrypted", retryable: false }],
    [
      "a deleted-document closing",
      { status: "failed", code: "document.deleted", retryable: false },
    ],
    ["a queued version", { status: "queued" }],
    ["a parsing version", { status: "parsing", attempt: 1 }],
    ["a ready version", { status: "ready", attempt: 1 }],
  ])("answers %s with 409 and changes nothing", async (_name, version) => {
    const user = await signIn(workspaceId, "member");
    const doc = await seedDoc(workspaceId, ownerAccount, version);
    const before = await state(doc.versionId);
    const res = await retry(user.token, workspaceId, doc.documentId);
    expect([res.status, res.body.error.code]).toEqual([409, "document.not_retryable"]);
    expect(await state(doc.versionId)).toEqual(before);
  });

  it("answers 404 for a deleted document and leaves it failed", async () => {
    const user = await signIn(workspaceId, "member");
    const doc = await failed(workspaceId, ownerAccount);
    await fx.fixture.query("update documents set deleted_at = now() where id = $1", [
      doc.documentId,
    ]);
    const res = await retry(user.token, workspaceId, doc.documentId);
    expect([res.status, res.body.error.code]).toEqual([404, "not_found"]);
    expect(await state(doc.versionId)).toMatchObject({ status: "failed", live: 0 });
  });

  it("refuses an unauthenticated request and a wrong or missing Origin", async () => {
    const user = await signIn(workspaceId, "member");
    const doc = await failed(workspaceId, ownerAccount);
    expect((await retry(null, workspaceId, doc.documentId)).status).toBe(401);
    expect((await retry(user.token, workspaceId, doc.documentId, null)).status).toBe(403);
    expect(
      (await retry(user.token, workspaceId, doc.documentId, "http://evil.example")).status,
    ).toBe(403);
    expect(await state(doc.versionId)).toMatchObject({ status: "failed" });
  });

  it("answers 404 for another workspace, a foreign document, an unknown and a malformed id", async () => {
    const user = await signIn(workspaceId, "member");
    const foreign = await failed(otherWorkspaceId, outsider.account);
    const cases: [string, string][] = [
      [workspaceId, foreign.documentId], // a document of another workspace
      [otherWorkspaceId, foreign.documentId], // not a member of that workspace
      [workspaceId, randomUUID()],
      [workspaceId, "not-a-uuid"],
    ];
    for (const [ws, id] of cases) {
      const res = await retry(user.token, ws, id);
      expect([res.status, res.body.error.code], id).toEqual([404, "not_found"]);
    }
    expect(await state(foreign.versionId)).toMatchObject({ status: "failed", live: 0 });
  });
});

describe("retry rate limit", () => {
  it(`allows ${MAX_RETRIES_PER_USER} requests per user, then 429 with Retry-After and no work`, async () => {
    const user = await signIn(workspaceId, "member");
    for (let n = 0; n < MAX_RETRIES_PER_USER; n++) {
      expect((await retry(user.token, workspaceId, randomUUID())).status).toBe(404);
    }
    const doc = await failed(workspaceId, ownerAccount);
    const res = await retry(user.token, workspaceId, doc.documentId);
    expect([res.status, res.body.error.code]).toEqual([429, "retry.throttled"]);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(await state(doc.versionId)).toMatchObject({ status: "failed", live: 0 });
  });

  it("is per user: another member is not affected", async () => {
    const busy = await signIn(workspaceId, "member");
    for (let n = 0; n < MAX_RETRIES_PER_USER; n++)
      await retry(busy.token, workspaceId, randomUUID());
    const other = await signIn(workspaceId, "member");
    const doc = await failed(workspaceId, ownerAccount);
    expect((await retry(other.token, workspaceId, doc.documentId)).status).toBe(202);
  });
});
