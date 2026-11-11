import { afterAll, expect, it } from "vitest";
import { openRolePools, ROLES } from "./role-test-support";

const pools = openRolePools();
afterAll(() => pools.close());

// The application role writes existing rows in two places only: sessions (login bookkeeping),
// credentials, the M1.7 delete command and the M1.8b retry command. A new UPDATE policy must be reviewed and listed here.
it("pins the application role's UPDATE policies to exactly the reviewed list", async () => {
  const { rows } = await pools.bootstrap.query<{ p: string }>(
    `select tablename || '.' || policyname as p from pg_policies
       where roles = array[$1]::name[] and cmd in ('UPDATE', 'ALL') order by 1`,
    [ROLES.app],
  );
  const updates = rows
    .map((r) => r.p)
    .filter((p) => /^(documents|document_versions|sections|chunks)\./.test(p));
  expect(updates).toEqual([
    "document_versions.document_versions_app_close",
    "document_versions.document_versions_app_retry",
    "documents.documents_app_delete",
  ]);
});
