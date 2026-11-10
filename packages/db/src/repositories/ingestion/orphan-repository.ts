import { maxAttempts, type OrphanRepository, type WorkspaceId } from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Executor } from "../../client";

// Two statements, raw SQL, for the reason `claim` splits its own: the version lock comes first and
// the outbox is read by a later statement, whose READ COMMITTED snapshot is taken after any
// concurrent redrive that held the lock has committed its entry. One statement could read the
// outbox before the lock wait ends and miss that entry. Only the version row is locked (FOR NO KEY
// UPDATE, `of dv`, the order `claim` and `markDispatched` use); no outbox row is ever locked, and
// nothing is written: status, attempt, generation and `updated_at` stay as they are.
//
// Idle time is `now()` minus the later of `updated_at` and the MAX of `dispatched_at` over every
// outbox row of the version, an aggregate that does not rely on `created_at` order. The row count
// is capped afterwards with `least`, so the cap never decides which rows feed the maximum.
// The aggregate relies on the outbox (workspace_id, version_id) history index (migration 0013).
export function createOrphanRepository(
  executor: Executor,
  workspaceId: WorkspaceId,
): OrphanRepository {
  return {
    async lockOrphan({ versionId, historyCap }) {
      const locked = await executor.execute<{ status: string; attempt: number }>(sql`
        select dv.status, dv.attempt from document_versions dv
        where dv.id = ${versionId} and dv.workspace_id = ${workspaceId}
          and dv.status in ('uploaded', 'queued') and dv.attempt < ${maxAttempts}
          and exists (select 1 from documents d
            where d.id = dv.document_id and d.workspace_id = dv.workspace_id
              and d.deleted_at is null)
        for no key update of dv`);
      const [version] = locked.rows;
      if (version === undefined) return null;
      if (version.status !== "uploaded" && version.status !== "queued") {
        throw new Error(`Unexpected orphan status ${version.status}`);
      }

      const { rows } = await executor.execute<{
        outbox_rows: number;
        has_live: boolean;
        idle_ms: number;
      }>(sql`
        select least(h.total, ${historyCap})::int as outbox_rows,
          coalesce(h.has_live, false) as has_live,
          (extract(epoch from now() - greatest(dv.updated_at, h.last_dispatched)) * 1000)::float8
            as idle_ms
        from document_versions dv
        cross join lateral (
          select count(*) as total, bool_or(o.dispatched_at is null) as has_live,
            max(o.dispatched_at) as last_dispatched
          from outbox o
          where o.workspace_id = dv.workspace_id and o.version_id = dv.id) h
        where dv.id = ${versionId} and dv.workspace_id = ${workspaceId}`);
      const [history] = rows;
      if (history === undefined || history.has_live) return null;
      return {
        status: version.status,
        attempt: version.attempt,
        outboxRows: history.outbox_rows,
        idleMs: history.idle_ms,
      };
    },
  };
}
