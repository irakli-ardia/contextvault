// Corpus preparation for the experiment: two tenants with a term only each of them has, and
// planner statistics that are verified rather than assumed.

import { assertAnalyzed, skippedTables } from "./keyword-experiment-checks.mjs";
import { createOwner, seedWorkspace } from "./retrieval-seed.mjs";

export const TABLES = [
  "users",
  "workspaces",
  "memberships",
  "documents",
  "document_versions",
  "sections",
  "chunks",
];
export const TENANT_B_CHUNKS = 1000;
export const TAGGED = 200;

/** Messages the server sent as notices or warnings on this connection (ANALYZE skips arrive so). */
export function collectNotices(client) {
  const messages = [];
  client.on("notice", (notice) => messages.push(notice.message));
  return messages;
}

/**
 * Tenant A (`chunks` chunks) and tenant B (1,000), each with its own user. A few of each tenant's
 * chunks carry a marker term that exists nowhere else, so any row of the other tenant is a leak.
 */
export async function seedTenants(fixture, chunks) {
  const tenants = [];
  for (const [total, term] of [
    [chunks, "kwtenanta"],
    [TENANT_B_CHUNKS, "kwtenantb"],
  ]) {
    const user = await createOwner(fixture);
    const workspace = await seedWorkspace(fixture, user, total, {
      embeddings: false,
      analyze: false, // the owner analyzes every table afterwards (analyzeAll)
    });
    const { rows } = await fixture.query(
      `update chunks set content = content || ' ' || $2::text
       where id in (select id from chunks where workspace_id = $1 order by id limit $3) returning id`,
      [workspace, term, TAGGED],
    );
    tenants.push({ user, workspace, term, ids: new Set(rows.map((r) => r.id)) });
  }
  return tenants;
}

/** ANALYZE as the table owner (the fixture role cannot), and fail if any table lacks statistics. */
export async function analyzeAll(owner, notices) {
  const seen = notices.length;
  await owner.query(`analyze ${TABLES.join(", ")}`);
  const skipped = skippedTables(notices.slice(seen));
  if (skipped.length > 0) throw new Error(`analyze skipped ${skipped.length} table(s)`);
  await assertAnalyzed(owner, TABLES);
}
