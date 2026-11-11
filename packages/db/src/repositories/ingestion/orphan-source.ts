import {
  maxAttempts,
  type OrphanSource,
  orphanPageLimit,
  outboxHistoryCap,
  parseDocumentVersionId,
  parseWorkspaceId,
  redriveBaseCooldownMs,
  redriveMaxCooldownMs,
} from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Database } from "../../client";

// Cross-workspace discovery, outside any transaction and with no workspace context, through the
// worker's existing SELECT grants only: ids, status, counters and times of document_versions, and
// the outbox (migration 0008). It cannot see live `documents` (only deleted, unpurged rows, for the purge: migration 0018), so a deleted document's waiting version
// is still listed; `lockOrphan` rejects it under the workspace-scoped lock. HARD prerequisite
// before 5B.4 activation or M1.7 deletion: terminalize those versions without widening this grant.
// Until then the cursor still advances past them, but they are listed on every scan.
//
// Advisory only: `lockOrphan` re-checks every predicate under the row lock. Eligible means
// uploaded/queued, attempts left, no outbox row without `dispatched_at` (due or future), and idle
// time (now minus the later of `updated_at` and the MAX `dispatched_at`, never `created_at` order)
// at least `redriveCooldownMs(rows, attempt)`. The SQL repeats that formula: rest = max(0, rows - 1
// - attempt), base * 2^rest, capped; `rows` is capped like `lockOrphan`'s, so rest <= 10 and the
// domain's exponent clamp of 7 changes nothing once the cap applies. A test pins SQL to the domain.
//
// Pagination is the keyset `(updated_at, id)` over eligible rows (the filter is in WHERE), as text:
// PostgreSQL keeps microseconds that a JavaScript Date would drop, which would re-list the row.
// Keyset pages are not a snapshot.
// The per-version outbox aggregate runs for every waiting row scanned; it depends on the
// (workspace_id, version_id) history index of migration 0013.
const separator = "|";

export function createOrphanSource(db: Database): OrphanSource {
  return {
    async listWaiting(limit, after) {
      if (!Number.isInteger(limit) || limit < 1 || limit > orphanPageLimit) {
        throw new RangeError(`limit must be an integer in 1..${orphanPageLimit}`);
      }
      const [at = "", id = ""] = after === undefined ? [] : after.split(separator);
      const afterCursor =
        after === undefined
          ? sql`true`
          : sql`(dv.updated_at, dv.id) > (${at}::timestamptz, ${id}::uuid)`;
      const { rows } = await db.execute<{ workspace_id: string; id: string; at: string }>(sql`
        select dv.workspace_id, dv.id, dv.updated_at::text as at
        from document_versions dv
        cross join lateral (
          select count(*) as total, bool_or(o.dispatched_at is null) as has_live,
            max(o.dispatched_at) as last_dispatched
          from outbox o
          where o.workspace_id = dv.workspace_id and o.version_id = dv.id) h
        where dv.status in ('uploaded', 'queued') and dv.attempt < ${maxAttempts}
          and not coalesce(h.has_live, false)
          and ${afterCursor}
          and extract(epoch from now() - greatest(dv.updated_at, h.last_dispatched)) * 1000
            >= least(${redriveMaxCooldownMs}::float8, ${redriveBaseCooldownMs}::float8
              * power(2, greatest(0, least(h.total, ${outboxHistoryCap}) - 1 - dv.attempt)))
        order by dv.updated_at, dv.id
        limit ${limit}`);
      return rows.map((row) => ({
        workspaceId: parseWorkspaceId(row.workspace_id),
        versionId: parseDocumentVersionId(row.id),
        cursor: `${row.at}${separator}${row.id}`,
      }));
    },
  };
}
