import type { DocumentDeletionRepository } from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Executor } from "../../client";

/**
 * Soft delete, one statement per step in the caller's transaction. Lock order is document, then
 * version, the same as activation, so a concurrent activation and delete serialize on the document
 * row and never wait in a cycle. Under that lock a worker's activation either committed before
 * (its `ready` version stays, the pointer is cleared) or finds the document deleted and writes
 * nothing. The version rows are closed after `deleted_at` is set; the database admits that update
 * only for a deleted document (policy document_versions_app_close). Raw SQL for the same reason as
 * `claim`: single-table column references stay unqualified in Drizzle.
 */
export function createDocumentDeletionRepository(executor: Executor): DocumentDeletionRepository {
  return {
    async softDelete(workspaceId, documentId) {
      // The row lock honours the update policy, which admits live documents only: a deleted
      // document locks as no row, and a plain read tells it apart from an absent one.
      const locked = await executor.execute(sql`
        select 1 from documents
        where id = ${documentId} and workspace_id = ${workspaceId} and deleted_at is null
        for no key update`);
      if (locked.rows.length === 0) {
        const known = await executor.execute(sql`
          select 1 from documents where id = ${documentId} and workspace_id = ${workspaceId}`);
        return known.rows.length === 0 ? "not_found" : "already_deleted";
      }

      await executor.execute(sql`
        update documents set deleted_at = now(), active_version_id = null
        where id = ${documentId} and workspace_id = ${workspaceId} and deleted_at is null`);
      // The generation bump is what fences a running worker: its heartbeat, transition, failure
      // and activation all match on the old generation and report `stale`.
      await executor.execute(sql`
        update document_versions
        set status = 'failed', error_stage = null, error_code = 'document.deleted',
            error_retryable = false, lease_generation = lease_generation + 1, updated_at = now()
        where document_id = ${documentId} and workspace_id = ${workspaceId}
          and status in ('uploaded', 'queued', 'parsing', 'chunking')`);
      return "deleted";
    },
  };
}
