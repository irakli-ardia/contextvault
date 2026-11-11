import type { DocumentId, WorkspaceId } from "../kernel/ids";
import type { DeadlineSignal, DocumentStore } from "./ports";
import type { PurgeSource, PurgeUnitOfWork } from "./purge-ports";
import { documentObjectKey } from "./storage-key";

export interface PurgeDocumentDeps {
  readonly uow: PurgeUnitOfWork;
  readonly store: DocumentStore;
}

export interface PurgeDocumentInput {
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  readonly retentionMs: number;
}

export type PurgeDocumentOutcome = "purged" | "skipped";

/**
 * Physical removal of one deleted document. Order is the safety argument: the database rows are
 * the only record of which objects exist, so the objects go first and the rows (with `purged_at`)
 * last, in one transaction with no network call inside it. A crash or failure at any point leaves
 * the document eligible, and every step repeats harmlessly: `store.delete` is idempotent, the row
 * deletes find nothing, and `purged_at` is set once. Two workers purging one document do the
 * same work twice. Object keys come from ids read under the workspace's RLS, never from input.
 */
export async function purgeDocument(
  deps: PurgeDocumentDeps,
  input: PurgeDocumentInput,
): Promise<PurgeDocumentOutcome> {
  const { workspaceId, documentId, retentionMs } = input;
  const versionIds = await deps.uow.run({ workspaceId }, (r) =>
    r.purge.readTargets({ documentId, retentionMs }),
  );
  if (versionIds === null) return "skipped";
  for (const versionId of versionIds) {
    await deps.store.delete(documentObjectKey(workspaceId, documentId, versionId));
  }
  const purged = await deps.uow.run({ workspaceId }, (r) =>
    r.purge.finalize({ documentId, versionIds }),
  );
  return purged ? "purged" : "skipped";
}

export interface PurgeBatch {
  readonly candidates: number;
  readonly purged: number;
  readonly skipped: number;
  /** Threw; the next sweep retries them. Errors are returned, never thrown. */
  readonly errors: readonly unknown[];
}

export interface PurgeSweepDeps extends PurgeDocumentDeps {
  readonly source: PurgeSource;
  readonly batchSize: number;
  readonly retentionMs: number;
}

/**
 * A sweep function holding an in-memory keyset cursor. Each call purges at most `batchSize`
 * documents after the cursor, so a document that always fails cannot starve the ones behind it;
 * a short page (the end of the set) wraps the cursor to the start. Discovery failures propagate.
 * The signal is checked only between documents, so a running purge always finishes whole.
 */
export function createPurgeSweep(
  deps: PurgeSweepDeps,
): (signal?: DeadlineSignal) => Promise<PurgeBatch> {
  let after: string | undefined;
  return async (signal) => {
    if (signal?.aborted) return { candidates: 0, purged: 0, skipped: 0, errors: [] };
    const candidates = await deps.source.listEligible({
      limit: deps.batchSize,
      retentionMs: deps.retentionMs,
      after,
    });
    after = candidates.length < deps.batchSize ? undefined : candidates.at(-1)?.cursor;
    let purged = 0;
    let skipped = 0;
    const errors: unknown[] = [];
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      try {
        const outcome = await purgeDocument(deps, {
          workspaceId: candidate.workspaceId,
          documentId: candidate.documentId,
          retentionMs: deps.retentionMs,
        });
        if (outcome === "purged") purged += 1;
        else skipped += 1;
      } catch (error) {
        errors.push(error);
      }
    }
    return { candidates: candidates.length, purged, skipped, errors };
  };
}
