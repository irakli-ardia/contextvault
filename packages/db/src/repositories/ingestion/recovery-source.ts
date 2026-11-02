import {
  parseDocumentVersionId,
  parseWorkspaceId,
  type RecoverySource,
} from "@contextvault/domain";
import { and, asc, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../../client";
import { documentVersions } from "../../schema/index";

// Cross-workspace discovery, outside any transaction and with no workspace context: the worker's
// SELECT policy on document_versions is `using (true)` over ids, status, counters and times
// (migration 0008). Advisory only: `expireLease` re-checks every predicate under the row lock.
// Oldest first, so the longest-dead lease is recovered first; the id makes the order total.
export function createRecoverySource(db: Database): RecoverySource {
  return {
    async listExpiredLeases(limit, leaseDurationMs) {
      const rows = await db
        .select({
          workspaceId: documentVersions.workspaceId,
          versionId: documentVersions.id,
          observedGeneration: documentVersions.leaseGeneration,
        })
        .from(documentVersions)
        .where(
          and(
            inArray(documentVersions.status, ["parsing", "chunking"]),
            lt(
              documentVersions.updatedAt,
              sql`now() - make_interval(secs => ${leaseDurationMs / 1000})`,
            ),
          ),
        )
        .orderBy(asc(documentVersions.updatedAt), asc(documentVersions.id))
        .limit(limit);
      return rows.map((row) => ({
        workspaceId: parseWorkspaceId(row.workspaceId),
        versionId: parseDocumentVersionId(row.versionId),
        observedGeneration: row.observedGeneration,
      }));
    },
  };
}
