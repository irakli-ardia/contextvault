import { isVersionStatus, type RecoveryRepository, type WorkspaceId } from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Executor } from "../../client";

// One compare-and-set statement, raw SQL for the same reason as `claim`: qualified names keep the
// correlated subquery from capturing `id`. The UPDATE takes the version's row lock, so a racing
// heartbeat or second recovery waits, then re-evaluates the predicate against the committed row:
// a fresh `updated_at` or a bumped generation no longer matches and the statement returns nothing.
// Expiry is judged on the database clock only. `updated_at`, status and attempt are left alone;
// the generation bump alone fences the dead worker. No outbox row is locked here, so the order
// outbox-then-version used by `claim` and the dispatcher is never inverted.
export function createRecoveryRepository(
  executor: Executor,
  workspaceId: WorkspaceId,
): RecoveryRepository {
  return {
    async expireLease({ versionId, observedGeneration, leaseDurationMs }) {
      const { rows } = await executor.execute<{
        status: string;
        attempt: number;
        lease_generation: number;
      }>(sql`
        update document_versions dv
        set lease_generation = dv.lease_generation + 1
        where dv.id = ${versionId} and dv.workspace_id = ${workspaceId}
          and dv.status in ('parsing', 'chunking')
          and dv.lease_generation = ${observedGeneration}
          and dv.updated_at < now() - make_interval(secs => ${leaseDurationMs / 1000})
          and exists (select 1 from documents d
            where d.id = dv.document_id and d.workspace_id = dv.workspace_id
              and d.deleted_at is null)
        returning dv.status, dv.attempt, dv.lease_generation`);
      const [row] = rows;
      if (row === undefined) return null;
      if (!isVersionStatus(row.status)) throw new Error(`Unknown version status ${row.status}`);
      return { status: row.status, attempt: row.attempt, leaseGeneration: row.lease_generation };
    },
  };
}
