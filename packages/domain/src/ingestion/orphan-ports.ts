import type { DocumentVersionId } from "../kernel/ids";
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
