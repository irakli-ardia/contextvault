import type { IngestionRepository, WorkspaceId } from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Executor } from "../../client";
import { chunks, sections } from "../../schema/index";

// A statement is one parameter list; stay well under PostgreSQL's 65,535.
const chunkBatch = 1_000;

/**
 * The fenced chunking -> ready transition and everything that goes with it, in the caller's
 * transaction. The version row is locked first (that decides ownership, so a stale or cancelled run
 * writes nothing), the derived rows are inserted while it is still `chunking` (the database refuses
 * them otherwise), and only then does it become `ready`, which the database refuses without chunks.
 * Raw SQL for the same reason as `claim`: Drizzle leaves single-table column references
 * unqualified, which the correlated subqueries would capture.
 */
export async function activateVersion(
  executor: Executor,
  workspaceId: WorkspaceId,
  { versionId, leaseGeneration, chunkSet }: Parameters<IngestionRepository["activate"]>[0],
): Promise<boolean> {
  // A programming error, not a verdict on a document: nothing is written, and the caller's
  // transaction ends with the throw. A ready version must have evidence to cite.
  if (chunkSet.sections.length === 0 || chunkSet.chunks.length === 0) {
    throw new Error("Activation needs at least one section and one chunk");
  }
  const fence = sql`dv.id = ${versionId} and dv.workspace_id = ${workspaceId}
      and dv.lease_generation = ${leaseGeneration} and dv.status = 'chunking'`;
  const locked = await executor.execute<{ document_id: string }>(sql`
    select dv.document_id from document_versions dv
    where ${fence}
      and exists (select 1 from documents d
        where d.id = dv.document_id and d.workspace_id = dv.workspace_id and d.deleted_at is null)
    for no key update of dv`);
  const [version] = locked.rows;
  if (version === undefined) return false;

  await executor
    .insert(sections)
    .values(chunkSet.sections.map((section) => ({ ...section, workspaceId, versionId })));
  for (let i = 0; i < chunkSet.chunks.length; i += chunkBatch) {
    await executor.insert(chunks).values(
      chunkSet.chunks.slice(i, i + chunkBatch).map((chunk) => ({
        ...chunk,
        contentSha256: Buffer.from(chunk.contentSha256),
        workspaceId,
        versionId,
        strategyId: chunkSet.strategyId,
        strategyVersion: chunkSet.strategyVersion,
      })),
    );
  }

  const ready = await executor.execute(sql`
    update document_versions dv set status = 'ready', updated_at = now()
    where ${fence} returning dv.id`);
  // The row is locked by this transaction, so a miss means the fence changed under it: undo it all.
  if (ready.rows.length === 0) throw new Error("Activation lost its version");

  // Lock the document in its own statement first. Under READ COMMITTED a statement's subqueries
  // use its start snapshot, so without this a newer version that commits while this waits for the
  // row would be invisible to the guard below and the pointer would move backwards.
  await executor.execute(sql`
    select 1 from documents
    where id = ${version.document_id} and workspace_id = ${workspaceId}
    for no key update`);

  // Moves the pointer only forward: when a newer version is already ready, this one is ready but
  // not active. The policy on documents refuses the same case, so this guard is not the only one.
  const activated = await executor.execute(sql`
    update documents d set active_version_id = ${versionId}
    where d.id = ${version.document_id} and d.workspace_id = ${workspaceId}
      and d.deleted_at is null
      and not exists (select 1 from document_versions n
        where n.document_id = d.id and n.workspace_id = d.workspace_id and n.status = 'ready'
          and n.version_no > (select version_no from document_versions where id = ${versionId}))
    returning d.id`);
  if (activated.rows.length > 0) return true;
  const live = await executor.execute(sql`
    select 1 from documents
    where id = ${version.document_id} and workspace_id = ${workspaceId} and deleted_at is null`);
  // Deleted between the statements: not a verdict, so undo everything and let recovery decide.
  if (live.rows.length === 0) throw new Error("Activation lost its document");
  return true;
}
