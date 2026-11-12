import type { IngestionRepository, WorkspaceId } from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Executor } from "../../client";
import { chunkEmbeddings, chunks, sections } from "../../schema/index";

// A statement is one parameter list; stay well under PostgreSQL's 65,535.
const chunkBatch = 1_000;
// A vector is ~10 KB of text on the wire, so its batches are smaller.
const embeddingBatch = 100;

/**
 * The fenced chunking -> ready transition and everything that goes with it (sections, chunks and their embeddings), in the caller's
 * transaction. The version row is locked first (that decides ownership, so a stale or cancelled run
 * writes nothing; the document is locked before it, see below), the derived rows are inserted while it is still `chunking` (the database refuses
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
  if (chunkSet.embeddings.length !== chunkSet.chunks.length) {
    throw new Error("Activation needs exactly one embedding per chunk");
  }
  const fence = sql`dv.id = ${versionId} and dv.workspace_id = ${workspaceId}
      and dv.lease_generation = ${leaseGeneration} and dv.status = 'chunking'`;
  // Lock order is document, then version: the order of the delete command, so the two never wait
  // on each other in a cycle. A deleted document is refused here, and once this lock is held no
  // delete can commit before this transaction ends. Only the document row is locked; the version
  // row is read, and locked by the next statement.
  const locked = await executor.execute<{ document_id: string }>(sql`
    select d.id as document_id from documents d
    join document_versions dv on dv.document_id = d.id and dv.workspace_id = d.workspace_id
    where dv.id = ${versionId} and dv.workspace_id = ${workspaceId} and d.deleted_at is null
    for no key update of d`);
  const [version] = locked.rows;
  if (version === undefined) return false;
  const owned = await executor.execute(sql`
    select 1 from document_versions dv where ${fence} for no key update of dv`);
  if (owned.rows.length === 0) return false;

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
  for (let i = 0; i < chunkSet.chunks.length; i += embeddingBatch) {
    await executor.insert(chunkEmbeddings).values(
      chunkSet.chunks.slice(i, i + embeddingBatch).flatMap((chunk, offset) => {
        const embedding = chunkSet.embeddings[i + offset];
        return embedding === undefined
          ? []
          : [
              {
                chunkId: chunk.id,
                workspaceId,
                versionId,
                model: chunkSet.embeddingModel,
                embedding: [...embedding],
              },
            ];
      }),
    );
  }

  const ready = await executor.execute(sql`
    update document_versions dv set status = 'ready', updated_at = now()
    where ${fence} returning dv.id`);
  // The row is locked by this transaction, so a miss means the fence changed under it: undo it all.
  if (ready.rows.length === 0) throw new Error("Activation lost its version");

  // Moves the pointer only forward. The document lock was taken before this statement started, so
  // a newer version that committed while this waited is visible to the guard. The policy on
  // documents refuses the same case, so this guard is not the only one.
  await executor.execute(sql`
    update documents d set active_version_id = ${versionId}
    where d.id = ${version.document_id} and d.workspace_id = ${workspaceId}
      and d.deleted_at is null
      and not exists (select 1 from document_versions n
        where n.document_id = d.id and n.workspace_id = d.workspace_id and n.status = 'ready'
          and n.version_no > (select version_no from document_versions where id = ${versionId}))
    returning d.id`);
  // Zero rows means a newer version is already ready: this one is ready but not active.
  return true;
}
