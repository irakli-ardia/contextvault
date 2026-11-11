import { afterAll, describe, expect, it } from "vitest";
import { openRolePools, ROLES, scalar } from "./role-test-support";

// Recovery discovery cannot see `documents` (worker RLS), so it cannot skip versions of deleted
// documents. That is safe only while every path that marks a document deleted also closes its
// non-terminal versions in the same transaction (plan: m1-secure-document-ingestion, "Deleted-
// document starvation"). M1.7 (migration 0017) grants that path to the application role and to
// nobody else: the grants below are exactly the delete command's. Physical removal of rows is not
// granted to anyone (purge is migration 0018, not built).
const pools = openRolePools();
afterAll(() => pools.close());

const can = (role: string, privilege: string, column?: string) =>
  scalar<boolean>(
    pools.bootstrap,
    column === undefined
      ? "select has_table_privilege($1, 'public.documents', $2) as v"
      : "select has_column_privilege($1, 'public.documents', $3, $2) as v",
    column === undefined ? [role, privilege] : [role, privilege, column],
  );

describe.each([ROLES.app, ROLES.worker])("%s holds no destructive document privilege", (role) => {
  it("cannot DELETE or TRUNCATE a document", async () => {
    expect(await can(role, "DELETE")).toBe(false);
    expect(await can(role, "TRUNCATE")).toBe(false);
  });

  // The reviewed exceptions: the worker's M1.6 activation sets active_version_id; the application
  // role's delete command (M1.7) sets deleted_at and clears active_version_id.
  const updatable =
    role === ROLES.worker ? ["active_version_id"] : ["deleted_at", "active_version_id"];
  it("can UPDATE only the reviewed document columns", async () => {
    expect(await can(role, "UPDATE")).toBe(false); // no table-level grant
    const columns = await pools.bootstrap.query<{ attname: string }>(
      `select attname from pg_attribute
       where attrelid = 'public.documents'::regclass and attnum > 0 and not attisdropped`,
    );
    expect(columns.rows.length).toBeGreaterThan(0);
    for (const { attname } of columns.rows) {
      expect(await can(role, "UPDATE", attname), `UPDATE(${attname})`).toBe(
        updatable.includes(attname),
      );
    }
  });
});

describe("the application role's version columns", () => {
  it("can UPDATE only the lifecycle columns the closing writes", async () => {
    const closing = [
      "status",
      "error_stage",
      "error_code",
      "error_retryable",
      "lease_generation",
      "updated_at",
    ];
    const columns = await pools.bootstrap.query<{ attname: string }>(
      `select attname from pg_attribute
       where attrelid = 'public.document_versions'::regclass and attnum > 0 and not attisdropped`,
    );
    for (const { attname } of columns.rows) {
      const granted = (
        await pools.bootstrap.query<{ v: boolean }>(
          "select has_column_privilege($1, 'public.document_versions', $2, 'UPDATE') as v",
          [ROLES.app, attname],
        )
      ).rows[0]?.v;
      expect(granted, `UPDATE(${attname})`).toBe(closing.includes(attname));
    }
  });
});

describe("the detection of a granted delete path", () => {
  // A scratch table, never `documents`: altering a table other tests use would take a lock on it.
  it("sees UPDATE(deleted_at) once granted (the check above is not vacuous)", async () => {
    const client = await pools.owner.connect();
    try {
      await client.query("begin");
      await client.query("create table public.probe_documents (deleted_at timestamptz)");
      await client.query(`grant update (deleted_at) on public.probe_documents to ${ROLES.app}`);
      const { rows } = await client.query<{ v: boolean }>(
        "select has_column_privilege($1, 'public.probe_documents', 'deleted_at', 'UPDATE') as v",
        [ROLES.app],
      );
      expect(rows[0]?.v).toBe(true);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });
});
