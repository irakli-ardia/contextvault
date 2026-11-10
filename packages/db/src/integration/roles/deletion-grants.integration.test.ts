import { afterAll, describe, expect, it } from "vitest";
import { openRolePools, ROLES, scalar } from "./role-test-support";

// Recovery discovery cannot see `documents` (worker RLS), so it cannot skip versions of deleted
// documents. That is safe only while no application path can mark a document deleted without
// closing its non-terminal versions (plan: m1-secure-document-ingestion, "HARD prerequisite").
// Until the M1.7 delete command ships, nobody but the owner and fixture roles may write
// `deleted_at` or remove a document. The M1.7 migration that grants the delete path must change
// this test in the same commit, together with the atomic closing behaviour.
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

describe.each([ROLES.app, ROLES.worker])("%s cannot delete documents", (role) => {
  it("cannot DELETE or TRUNCATE a document", async () => {
    expect(await can(role, "DELETE")).toBe(false);
    expect(await can(role, "TRUNCATE")).toBe(false);
  });

  it("cannot UPDATE any document column, deleted_at included", async () => {
    expect(await can(role, "UPDATE")).toBe(false);
    const columns = await pools.bootstrap.query<{ attname: string }>(
      `select attname from pg_attribute
       where attrelid = 'public.documents'::regclass and attnum > 0 and not attisdropped`,
    );
    expect(columns.rows.length).toBeGreaterThan(0);
    for (const { attname } of columns.rows) {
      expect(await can(role, "UPDATE", attname), `UPDATE(${attname})`).toBe(false);
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
