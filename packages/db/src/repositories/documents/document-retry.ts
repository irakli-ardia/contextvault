import type { DocumentRetryRepository } from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Executor } from "../../client";

/**
 * Manual retry, one statement per step in the caller's transaction. Lock order is document, then
 * version, then outbox: the same as delete and activation, so a concurrent delete serializes on
 * the document row, and the worker's version-then-outbox order is never inverted. The document
 * lock honours the update policy, which admits live documents only; a deleted one locks as no row.
 * The version update is the compare-and-set: the policy (migration 0019) admits only the latest
 * version of a live document, failed with a retryable error, becoming queued with attempt 0 and no
 * recorded failure. `lease_generation + 1` fences any writer still holding the old generation. The
 * outbox insert has no RETURNING and no ON CONFLICT: the application role cannot read `outbox`,
 * and a failed version has no live entry, so a conflict is a bug that rolls everything back.
 * Raw SQL for the same reason as `softDelete`.
 */
export function createDocumentRetryRepository(executor: Executor): DocumentRetryRepository {
  return {
    async retry(workspaceId, documentId, outboxId) {
      const locked = await executor.execute(sql`
        select 1 from documents
        where id = ${documentId} and workspace_id = ${workspaceId} and deleted_at is null
        for no key update`);
      if (locked.rows.length === 0) return "not_found";

      const moved = await executor.execute<{ id: string }>(sql`
        update document_versions dv
        set status = 'queued', attempt = 0, lease_generation = dv.lease_generation + 1,
            error_stage = null, error_code = null, error_retryable = null, updated_at = now()
        where dv.document_id = ${documentId} and dv.workspace_id = ${workspaceId}
          and dv.status = 'failed' and dv.error_retryable = true
          and not exists (select 1 from document_versions n
            where n.document_id = dv.document_id and n.workspace_id = dv.workspace_id
              and n.version_no > dv.version_no)
        returning dv.id`);
      const [version] = moved.rows;
      if (version === undefined) return "not_retryable";

      await executor.execute(sql`
        insert into outbox (id, workspace_id, version_id, kind)
        values (${outboxId}, ${workspaceId}, ${version.id}, 'process_version')`);
      return "retried";
    },
  };
}
