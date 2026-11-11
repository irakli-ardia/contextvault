import {
  type PurgeRepository,
  parseDocumentVersionId,
  type WorkspaceId,
} from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Executor } from "../../client";

// Every statement names the job's workspace on top of RLS, so a document id from another tenant
// matches nothing. Raw SQL for the same reason as `claim`: Drizzle leaves single-table column
// references unqualified, which correlated subqueries would capture.
export function createPurgeRepository(
  executor: Executor,
  workspaceId: WorkspaceId,
): PurgeRepository {
  return {
    async readTargets({ documentId, retentionMs }) {
      const eligible = await executor.execute(sql`
        select 1 from documents d
        where d.id = ${documentId} and d.workspace_id = ${workspaceId}
          and d.deleted_at is not null and d.purged_at is null
          and d.deleted_at <= now() - ${retentionMs} * interval '1 millisecond'
          and not exists (select 1 from document_versions v
            where v.document_id = d.id and v.workspace_id = d.workspace_id
              and v.status in ('uploaded', 'queued', 'parsing', 'chunking'))`);
      if (eligible.rows.length === 0) return null;
      const { rows } = await executor.execute<{ id: string }>(sql`
        select id from document_versions
        where document_id = ${documentId} and workspace_id = ${workspaceId}
        order by version_no`);
      return rows.map((row) => parseDocumentVersionId(row.id));
    },

    async finalize({ documentId, versionIds }) {
      const listed = sql.join(
        versionIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      // Empty lists are impossible (a document has its first version), but `in ()` is a syntax error.
      if (versionIds.length > 0) {
        await executor.execute(sql`
          delete from chunks where workspace_id = ${workspaceId} and version_id in (${listed})`);
        await executor.execute(sql`
          delete from sections where workspace_id = ${workspaceId} and version_id in (${listed})`);
      }
      // A version that appeared after `readTargets` was never listed, so its object may exist:
      // refuse to mark, and the next sweep starts over. The policy independently refuses the
      // mark while any chunk or running version remains.
      const unlisted =
        versionIds.length > 0
          ? sql`and not exists (select 1 from document_versions v
              where v.document_id = ${documentId} and v.workspace_id = ${workspaceId}
                and v.id not in (${listed}))`
          : sql``;
      const marked = await executor.execute(sql`
        update documents set purged_at = now()
        where id = ${documentId} and workspace_id = ${workspaceId}
          and deleted_at is not null and purged_at is null ${unlisted}
        returning id`);
      return marked.rows.length > 0;
    },
  };
}
