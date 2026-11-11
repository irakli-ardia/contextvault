import { StorageError } from "../documents/errors";
import type { DeadlineSignal, DocumentStore } from "../documents/ports";
import { documentObjectKey } from "../documents/storage-key";
import type { DocumentId, DocumentVersionId, WorkspaceId } from "../kernel/ids";
import type { WorkerUnitOfWork } from "./ports";
import { StageFailure } from "./stage-runner";

/** Inside the caller's worker unit of work, under the job's workspace. */
export interface ParseSourceRepository {
  /** The document of the version, or `null` when either is missing or the document is deleted. */
  findParseSource(
    versionId: DocumentVersionId,
  ): Promise<{ readonly documentId: DocumentId } | null>;
}

export type ParseSourceUnitOfWork = WorkerUnitOfWork<{ parseSource: ParseSourceRepository }>;

export interface ReadVersionBytesDeps {
  readonly uow: ParseSourceUnitOfWork;
  readonly store: DocumentStore;
}

export interface ReadVersionBytesInput {
  readonly workspaceId: WorkspaceId;
  readonly versionId: DocumentVersionId;
  readonly maxBytes: number;
  readonly signal: DeadlineSignal;
}

// The key is derived from ids read under the job's workspace (RLS plus the workspace predicate),
// never taken from the payload, so a forged version id cannot reach another tenant's object. The
// transaction ends before the network call. Deleted and missing are re-checked here because the
// claim happened earlier. An object over `maxBytes` is refused without being kept.
export async function readVersionBytes(
  deps: ReadVersionBytesDeps,
  { workspaceId, versionId, maxBytes, signal }: ReadVersionBytesInput,
): Promise<Uint8Array> {
  const source = await deps.uow.run({ workspaceId }, ({ parseSource }) =>
    parseSource.findParseSource(versionId),
  );
  if (!source) throw new StageFailure("document.unavailable", false);
  try {
    const bytes = await deps.store.get(
      documentObjectKey(workspaceId, source.documentId, versionId),
      {
        maxBytes,
        signal,
      },
    );
    if (!bytes) throw new StageFailure("storage.missing", false);
    return bytes;
  } catch (error) {
    if (error instanceof StageFailure) throw error;
    if (error instanceof StorageError) {
      throw new StageFailure(error.code, error.retryable, { cause: error });
    }
    throw error;
  }
}
