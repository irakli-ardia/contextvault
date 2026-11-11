import { randomBytes, randomUUID } from "node:crypto";
import { parseDocumentListResponse, parseDocumentResponse } from "@contextvault/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  type Api,
  createTenantFixture,
  loginAs,
  seedAccount,
  startApi,
} from "../../testing/test-support";

const fx = await createTenantFixture(4);
let api: Api;
let owner: { account: Account; token: string };
let member: { account: Account; token: string };
let outsider: { account: Account; token: string };
let workspaceId: string;
let otherWorkspaceId: string;
let emptyWorkspaceId: string;

const signIn = async (account: Account) => ({
  account,
  token: (await loginAs(api, account)).token,
});
const get = (token: string | null, path: string) => {
  const req = api.http.get(path);
  return token === null ? req : req.set("Cookie", `cv_session=${token}`);
};

interface Seed {
  readonly ws: string;
  readonly by: Account;
  readonly name?: string;
  readonly createdAt?: string;
  readonly status?: string;
  readonly error?: [string, boolean];
  readonly deleted?: boolean;
}
async function seedDoc(seed: Seed) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  await fx.fixture.query(
    `insert into documents (id, workspace_id, display_name, mime, size_bytes, content_sha256, created_by, created_at, deleted_at)
     values ($1, $2, $3, 'text/plain', 7, $4, $5, $6, $7)`,
    [
      documentId,
      seed.ws,
      seed.name ?? "a.txt",
      randomBytes(32),
      seed.by.id,
      seed.createdAt ?? new Date().toISOString(),
      seed.deleted ? new Date().toISOString() : null,
    ],
  );
  await fx.fixture.query(
    `insert into document_versions (id, document_id, workspace_id, version_no, storage_key, status, error_stage, error_code, error_retryable)
     values ($1, $2, $3, 1, $4, $5, $6, $7, $8)`,
    [
      versionId,
      documentId,
      seed.ws,
      `ws/${seed.ws}/doc/${documentId}/v/${versionId}`,
      seed.status ?? "ready",
      seed.error ? "parsing" : null,
      seed.error?.[0] ?? null,
      seed.error?.[1] ?? null,
    ],
  );
  return { documentId, versionId };
}

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
  emptyWorkspaceId = await fx.createWorkspace(a.id, "Empty");
  await fx.fixture.query(
    "insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member')",
    [workspaceId, c.id],
  );
  [owner, member, outsider] = await Promise.all([signIn(a), signIn(c), signIn(d)]);
  void b;
});
afterAll(async () => {
  await api.app.close();
  await fx.close();
});

describe("GET /workspaces/:workspaceId/documents", () => {
  it("lists newest first with status and the stable failure, exposing nothing else", async () => {
    const ws = await fx.createWorkspace(owner.account.id, "Order");
    const old = await seedDoc({
      ws,
      by: owner.account,
      name: "old",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const failed = await seedDoc({
      ws,
      by: owner.account,
      name: "bad",
      createdAt: "2026-02-01T00:00:00Z",
      status: "failed",
      error: ["parse.encrypted", false],
    });
    const fresh = await seedDoc({
      ws,
      by: owner.account,
      name: "new",
      createdAt: "2026-03-01T00:00:00Z",
      status: "parsing",
    });
    const res = await get(owner.token, `/workspaces/${ws}/documents`);
    expect(res.status).toBe(200);
    const list = parseDocumentListResponse(res.body);
    expect(list?.documents.map((d) => [d.id, d.status, d.error])).toEqual([
      [fresh.documentId, "parsing", null],
      [failed.documentId, "failed", { code: "parse.encrypted", retryable: false }],
      [old.documentId, "ready", null],
    ]);
    // Contract-exact keys, and no stored internals anywhere in the body.
    expect(Object.keys(res.body.documents[0]).sort()).toEqual(
      ["createdAt", "displayName", "error", "id", "mime", "sizeBytes", "status"].sort(),
    );
    expect(res.text).not.toMatch(
      /ws\/|storage_?key|sha256|content_sha|leaseGeneration|attempt|stage/i,
    );
  });

  it("hides soft-deleted documents and returns at most 50", async () => {
    const ws = await fx.createWorkspace(owner.account.id, "Cap");
    const gone = await seedDoc({ ws, by: owner.account, deleted: true });
    for (let i = 0; i < 55; i++) await seedDoc({ ws, by: owner.account });
    const res = await get(owner.token, `/workspaces/${ws}/documents`);
    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(50);
    expect(res.body.documents.map((d: { id: string }) => d.id)).not.toContain(gone.documentId);
  });

  it("gives a member the same read, and an empty workspace an empty list", async () => {
    await seedDoc({ ws: workspaceId, by: owner.account });
    const res = await get(member.token, `/workspaces/${workspaceId}/documents`);
    expect(res.status).toBe(200);
    expect(res.body.documents.length).toBeGreaterThan(0);
    const empty = await get(owner.token, `/workspaces/${emptyWorkspaceId}/documents`);
    expect([empty.status, empty.body]).toEqual([200, { documents: [] }]);
  });

  it("never lists another workspace's documents and answers 404 to a non-member", async () => {
    const foreign = await seedDoc({ ws: otherWorkspaceId, by: outsider.account });
    const own = await get(owner.token, `/workspaces/${workspaceId}/documents`);
    expect(own.body.documents.map((d: { id: string }) => d.id)).not.toContain(foreign.documentId);
    const res = await get(owner.token, `/workspaces/${otherWorkspaceId}/documents`);
    expect([res.status, res.body.error.code]).toEqual([404, "not_found"]);
  });

  it("requires a session", async () => {
    expect((await get(null, `/workspaces/${workspaceId}/documents`)).status).toBe(401);
  });
});

describe("GET /workspaces/:workspaceId/documents/:documentId", () => {
  it("returns one document matching the contract, for owner and member", async () => {
    const doc = await seedDoc({
      ws: workspaceId,
      by: owner.account,
      status: "failed",
      error: ["storage.unavailable", true],
    });
    for (const who of [owner, member]) {
      const res = await get(who.token, `/workspaces/${workspaceId}/documents/${doc.documentId}`);
      expect(res.status).toBe(200);
      expect(parseDocumentResponse(res.body)).toMatchObject({
        id: doc.documentId,
        status: "failed",
        error: { code: "storage.unavailable", retryable: true },
      });
    }
  });

  it("answers 404 identically for deleted, foreign, absent and malformed ids", async () => {
    const deleted = await seedDoc({ ws: workspaceId, by: owner.account, deleted: true });
    const foreign = await seedDoc({ ws: otherWorkspaceId, by: outsider.account });
    const cases: [string, string][] = [
      [workspaceId, deleted.documentId],
      [workspaceId, foreign.documentId], // another workspace's document through our workspace
      [otherWorkspaceId, foreign.documentId], // not a member of that workspace
      [workspaceId, randomUUID()],
      [workspaceId, "not-a-uuid"],
    ];
    const seen = new Set<string>();
    for (const [ws, id] of cases) {
      const res = await get(owner.token, `/workspaces/${ws}/documents/${id}`);
      expect(res.status, id).toBe(404);
      seen.add(JSON.stringify(res.body.error.code));
    }
    expect([...seen]).toEqual(['"not_found"']);
  });

  it("requires a session", async () => {
    const doc = await seedDoc({ ws: workspaceId, by: owner.account });
    expect((await get(null, `/workspaces/${workspaceId}/documents/${doc.documentId}`)).status).toBe(
      401,
    );
  });
});
