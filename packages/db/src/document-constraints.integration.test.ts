import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDocument, sha256, type Upload } from "./document-fixture";
import { createTenantFixture, sqlState } from "./tenant-fixture";

const fx = await createTenantFixture(2);
let doc: Upload;

beforeAll(async () => {
  const user = await fx.seedUser();
  doc = await seedDocument(fx, await fx.createWorkspace(user), user);
});
afterAll(() => fx.close());

// The owner role skips RLS but not constraints, so these probe the schema itself.
const insertDocument = (o: Record<string, unknown> = {}) => {
  const row = {
    id: randomUUID(),
    workspace_id: doc.workspaceId,
    display_name: "a.pdf",
    mime: "application/pdf",
    size_bytes: 1,
    content_sha256: sha256(randomUUID()),
    created_by: doc.createdBy,
    ...o,
  };
  return fx.fixture.query(
    `insert into documents (${Object.keys(row).join(",")}) values (${Object.keys(row)
      .map((_, i) => `$${i + 1}`)
      .join(",")})`,
    Object.values(row),
  );
};
const insertVersion = (o: Record<string, string | number> = {}) => {
  const base = {
    id: randomUUID(),
    document_id: doc.documentId,
    workspace_id: doc.workspaceId,
    version_no: 2,
    ...o,
  };
  // The key follows the ids unless a case sets it, so the foreign key is what gets tested.
  const key = `ws/${base.workspace_id}/doc/${base.document_id}/v/${base.id}`;
  const row = { storage_key: key, ...base };
  return fx.fixture.query(
    `insert into document_versions (${Object.keys(row).join(",")}) values (${Object.keys(row)
      .map((_, k) => `$${k + 1}`)
      .join(",")})`,
    Object.values(row),
  );
};

describe("documents", () => {
  it.each([
    ["unknown mime", { mime: "image/png" }],
    ["empty file", { size_bytes: 0 }],
    ["file over 10 MiB", { size_bytes: 10 * 1024 * 1024 + 1 }],
    ["short hash", { content_sha256: Buffer.alloc(31) }],
    ["empty name", { display_name: "" }],
    ["name over 255 bytes", { display_name: "é".repeat(128) }],
  ])("rejects %s", async (_name, override) => {
    expect(await sqlState(insertDocument(override))).toBe("23514");
  });

  it("rejects a workspace that does not exist", async () => {
    expect(await sqlState(insertDocument({ workspace_id: randomUUID() }))).toBe("23503");
  });
});

describe("document versions", () => {
  it("accepts a well-formed second version", async () => {
    expect(await sqlState(insertVersion())).toBeUndefined();
  });

  it.each([
    ["a status outside the six", { status: "published" }, "23514"],
    ["version number 0", { version_no: 0 }, "23514"],
    ["a negative attempt", { attempt: -1 }, "23514"],
    [
      "a storage key that names other ids",
      { storage_key: `ws/${randomUUID()}/doc/${randomUUID()}/v/${randomUUID()}` },
      "23514",
    ],
    ["a repeated version number", { version_no: 1 }, "23505"],
    [
      "a document that is not in the stated workspace",
      { workspace_id: randomUUID(), version_no: 3 },
      "23503",
    ],
  ])("rejects %s", async (_name, override, code) => {
    expect(await sqlState(insertVersion(override))).toBe(code);
  });

  it("rejects a version of a missing document", async () => {
    expect(await sqlState(insertVersion({ document_id: randomUUID(), version_no: 4 }))).toBe(
      "23503",
    );
  });
});

describe("pending uploads", () => {
  const insertPending = (o: Record<string, unknown> = {}) => {
    const id = randomUUID();
    const row = {
      id,
      workspace_id: doc.workspaceId,
      storage_key: `ws/${doc.workspaceId}/doc/${randomUUID()}/v/${id}`,
      declared_bytes: 1,
      created_by: doc.createdBy,
      ...o,
    };
    return fx.fixture.query(
      `insert into pending_uploads (${Object.keys(row).join(",")}) values (${Object.keys(row)
        .map((_, i) => `$${i + 1}`)
        .join(",")})`,
      Object.values(row),
    );
  };

  it.each([
    ["zero bytes", { declared_bytes: 0 }],
    ["over 10 MiB", { declared_bytes: 10 * 1024 * 1024 + 1 }],
    [
      "a key of another workspace",
      { storage_key: `ws/${randomUUID()}/doc/${randomUUID()}/v/${randomUUID()}` },
    ],
  ])("rejects %s", async (_name, override) => {
    expect(await sqlState(insertPending(override))).toBe("23514");
  });
});

describe("row security survives privileged migrations", () => {
  it("is enabled and forced on all three tables, bound to the application role (the worker's are pinned in catalog-invariants)", async () => {
    const tables = ["document_versions", "documents", "pending_uploads"];
    const flags = await fx.queryAs<{ relname: string; on: boolean; forced: boolean }>(
      null,
      "select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class where relname = any($1) order by relname",
      [tables],
    );
    expect(flags).toEqual(tables.map((relname) => ({ relname, on: true, forced: true })));
    const policies = await fx.queryAs<{ tablename: string; cmd: string; roles: string }>(
      null,
      "select tablename, cmd, roles::text from pg_policies where tablename = any($1) and roles <> array['contextvault_worker']::name[] order by tablename, cmd",
      [tables],
    );
    expect(policies.map((p) => `${p.tablename}:${p.cmd}`)).toEqual([
      "document_versions:INSERT",
      "document_versions:SELECT",
      "documents:INSERT",
      "documents:SELECT",
      "pending_uploads:DELETE",
      "pending_uploads:INSERT",
      "pending_uploads:SELECT",
    ]);
    expect(policies.every((p) => p.roles === "{contextvault_app}")).toBe(true);
  });

  it("grants the application role no more than the plan", async () => {
    const granted = await fx.queryAs<{ table_name: string; privilege_type: string }>(
      null,
      `select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'contextvault_app' and table_name in ('documents','document_versions','pending_uploads')
       order by table_name, privilege_type`,
    );
    expect(granted.map((g) => `${g.table_name}:${g.privilege_type}`)).toEqual([
      "document_versions:INSERT",
      "document_versions:SELECT",
      "documents:INSERT",
      "documents:SELECT",
      "pending_uploads:DELETE",
      "pending_uploads:INSERT",
      "pending_uploads:SELECT",
    ]);
  });
});
