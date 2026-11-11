import {
  type PurgeSource,
  parseDocumentId,
  parseWorkspaceId,
  purgePageLimit,
} from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Database } from "../../client";

// Cross-workspace discovery, outside any transaction and with no workspace context: the worker's
// policy documents_worker_discover_deleted admits deleted, unpurged documents only, through the
// columns id, workspace_id, deleted_at and purged_at (migration 0018). Advisory: `readTargets`
// re-checks everything inside the document's workspace. Keyset `(deleted_at, id)` as text, so
// PostgreSQL's microseconds survive; it uses documents_purge_pending_idx.
const separator = "|";

export function createPurgeSource(db: Database): PurgeSource {
  return {
    async listEligible({ limit, retentionMs, after }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > purgePageLimit) {
        throw new RangeError(`limit must be an integer in 1..${purgePageLimit}`);
      }
      if (!Number.isInteger(retentionMs) || retentionMs < 0) {
        throw new RangeError("retentionMs must be a non-negative integer");
      }
      const [at = "", id = ""] = after === undefined ? [] : after.split(separator);
      const afterCursor =
        after === undefined ? sql`true` : sql`(deleted_at, id) > (${at}::timestamptz, ${id}::uuid)`;
      const { rows } = await db.execute<{ workspace_id: string; id: string; at: string }>(sql`
        select workspace_id, id, deleted_at::text as at
        from documents
        where deleted_at is not null and purged_at is null
          and deleted_at <= now() - ${retentionMs} * interval '1 millisecond'
          and ${afterCursor}
        order by deleted_at, id
        limit ${limit}`);
      return rows.map((row) => ({
        workspaceId: parseWorkspaceId(row.workspace_id),
        documentId: parseDocumentId(row.id),
        cursor: `${row.at}${separator}${row.id}`,
      }));
    },
  };
}
