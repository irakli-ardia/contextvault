import type { WorkerUnitOfWork } from "../ingestion/ports";
import type { DocumentId, DocumentVersionId, WorkspaceId } from "../kernel/ids";

/** Position in the `(deleted_at, id)` order. Opaque: only the source that issued it reads it. */
export type PurgeCursor = string;

/** Ids only; never document data. Advisory: `readTargets` alone decides eligibility. */
export interface PurgeCandidate {
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  readonly cursor: PurgeCursor;
}

/** Discovery across workspaces, outside any transaction. */
export interface PurgeSource {
  /**
   * Deleted, unpurged documents whose deletion is at least `retentionMs` old by the database
   * clock, oldest first, strictly after `after` in `(deleted_at, id)` order. `limit` is an integer
   * in `1..purgePageLimit`.
   */
  listEligible(input: {
    readonly limit: number;
    readonly retentionMs: number;
    readonly after?: PurgeCursor | undefined;
  }): Promise<readonly PurgeCandidate[]>;
}

export const purgePageLimit = 100;

/** Steps inside the caller's worker unit of work (one workspace, one short transaction each). */
export interface PurgeRepository {
  /**
   * The version ids of an eligible document: deleted, unpurged, past retention, and no version
   * still waiting or running. `null` when ineligible; nothing is changed either way.
   */
  readTargets(input: {
    readonly documentId: DocumentId;
    readonly retentionMs: number;
  }): Promise<readonly DocumentVersionId[] | null>;
  /**
   * Removes the chunks and sections of exactly these versions and marks the document purged, all
   * or nothing. `false` when the document is no longer eligible, or has a version not listed
   * (nothing is marked; the next sweep starts over). The caller has already deleted the objects.
   */
  finalize(input: {
    readonly documentId: DocumentId;
    readonly versionIds: readonly DocumentVersionId[];
  }): Promise<boolean>;
}

export type PurgeUnitOfWork = WorkerUnitOfWork<{ purge: PurgeRepository }>;
