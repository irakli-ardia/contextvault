import type { UploadQuota, WorkspaceId } from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Executor } from "../../client";

// Takes the per-workspace quota lock for the rest of the transaction. An advisory lock rather
// than SELECT ... FOR UPDATE on workspaces: the application role has no UPDATE on that table.
// Every call that reads usage to decide must hold it, or two callers can both pass.
export async function lockWorkspaceQuota(
  executor: Executor,
  workspaceId: WorkspaceId,
): Promise<void> {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`document-quota:${workspaceId}`}, 0))`,
  );
}

interface Usage {
  readonly documents: number;
  readonly bytes: number;
}

// Live documents plus every reservation except `ownReservationId`, whatever its age.
async function usage(
  executor: Executor,
  workspaceId: WorkspaceId,
  ownReservationId: string,
): Promise<Usage> {
  const { rows } = await executor.execute<{ documents: string; bytes: string }>(sql`select
    (select count(*) from "documents" where workspace_id = ${workspaceId} and deleted_at is null)
    + (select count(*) from "pending_uploads" where workspace_id = ${workspaceId} and id <> ${ownReservationId})
      as documents,
    (select coalesce(sum(size_bytes), 0) from "documents" where workspace_id = ${workspaceId} and deleted_at is null)
    + (select coalesce(sum(declared_bytes), 0) from "pending_uploads" where workspace_id = ${workspaceId} and id <> ${ownReservationId})
      as bytes`);
  const [row] = rows;
  if (row === undefined) throw new Error("Usage query returned no row");
  return { documents: Number(row.documents), bytes: Number(row.bytes) };
}

/** Whether one more document of `bytes` fits; the refusal names the first ceiling it breaks. */
export async function quotaRefusal(
  executor: Executor,
  workspaceId: WorkspaceId,
  ownReservationId: string,
  bytes: number,
  quota: UploadQuota,
): Promise<"documents" | "bytes" | null> {
  const used = await usage(executor, workspaceId, ownReservationId);
  if (used.documents + 1 > quota.maxDocuments) return "documents";
  if (used.bytes + bytes > quota.maxBytes) return "bytes";
  return null;
}
