import type { DocumentVersionId, WorkspaceId } from "../kernel/ids";
import type { IngestionRepository, WorkerUnitOfWork } from "./ports";

/** What `lockOrphan` saw: an unclaimed version with no live outbox entry. */
export interface OrphanSnapshot {
  readonly status: "uploaded" | "queued";
  /** Business attempts claimed so far; redrive never changes it. */
  readonly attempt: number;
  /** Outbox rows ever written for the version, counted up to `historyCap`. */
  readonly outboxRows: number;
  /** Time since the later of the version's `updated_at` and its latest `dispatched_at`, by the database clock. */
  readonly idleMs: number;
}

/** Steps inside the caller's worker unit of work. */
export interface OrphanRepository {
  /**
   * Locks an unclaimed version and returns its snapshot. `null` when ineligible: not
   * uploaded/queued, attempts spent, document deleted, or a live outbox entry exists.
   * INVARIANTS: the adapter and `IngestionRepository` MUST share one transaction and executor (no
   * transaction per call). The adapter MUST take FOR NO KEY UPDATE on the version row before
   * checking outbox liveness, and the caller inserts its entry afterwards in that transaction. That
   * is the order `claim` and `markDispatched` use; any other order lets a concurrent redrive
   * insert a second live row.
   */
  lockOrphan(input: {
    readonly versionId: DocumentVersionId;
    readonly historyCap: number;
  }): Promise<OrphanSnapshot | null>;
}

export type OrphanUnitOfWork = WorkerUnitOfWork<{
  orphan: OrphanRepository;
  ingestion: IngestionRepository;
}>;

/** Position in the `(updated_at, id)` order. Opaque: only the source that issued it reads it. */
export type OrphanCursor = string;

/** Ids only; never document data. Advisory: `lockOrphan` alone decides eligibility. */
export interface OrphanCandidate {
  readonly workspaceId: WorkspaceId;
  readonly versionId: DocumentVersionId;
  /** The position of this candidate, to resume a scan after it. */
  readonly cursor: OrphanCursor;
}

/** Discovery across workspaces, outside any transaction. */
export interface OrphanSource {
  /**
   * Waiting versions (uploaded/queued, attempts left, no live outbox entry, idle past the redrive
   * cooldown by the database clock), oldest `updated_at` first. `limit` is an integer in
   * `1..orphanPageLimit`. With `after`, only candidates strictly later in `(updated_at, id)` order.
   * The scan is over eligible candidates, so a page skips any number of ineligible rows. Keyset
   * pages are not a snapshot: concurrent writes can add, move or drop candidates between pages.
   */
  listWaiting(limit: number, after?: OrphanCursor): Promise<readonly OrphanCandidate[]>;
}
