import { afterAll, expect, it } from "vitest";
import { openRolePools, ROLES } from "./role-test-support";

const pools = openRolePools();
afterAll(() => pools.close());

it("pins the worker role's policies to exactly the reviewed list", async () => {
  const { rows } = await pools.bootstrap.query<{ p: string }>(
    `select tablename || '.' || policyname as p from pg_policies
       where roles = array[$1]::name[] order by 1`,
    [ROLES.worker],
  );
  expect(rows.map((r) => r.p)).toEqual([
    "chunks.chunks_worker_insert",
    "chunks.chunks_worker_select",
    "document_versions.document_versions_worker_discover",
    "document_versions.document_versions_worker_update",
    "documents.documents_worker_activate",
    "documents.documents_worker_select",
    "outbox.outbox_worker_discover",
    "outbox.outbox_worker_insert",
    "outbox.outbox_worker_mark",
    "sections.sections_worker_insert",
  ]);
});
