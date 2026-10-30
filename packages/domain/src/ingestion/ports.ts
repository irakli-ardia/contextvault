import type { VersionStatus } from "../documents/document";
import type { DocumentVersionId, OutboxId, WorkspaceId } from "../kernel/ids";
import type { UnitOfWorkOptions } from "../kernel/unit-of-work";
import type { IngestionFailure } from "./lifecycle";

/** The worker acts for no user: it asserts one workspace, and RLS confines the transaction to it. */
export interface WorkerContext {
  readonly workspaceId: WorkspaceId;
}

export interface WorkerUnitOfWork<Repos> {
  /** Same outcome contract as `UnitOfWork.run`, including `TransactionOutcomeUnknown`. */
  run<T>(
    context: WorkerContext,
    work: (repos: Repos) => Promise<T>,
    options?: UnitOfWorkOptions,
  ): Promise<T>;
}

/** Ids only; never document data. */
export interface OutboxEntry {
  readonly id: OutboxId;
  readonly workspaceId: WorkspaceId;
  readonly versionId: DocumentVersionId;
  readonly availableAt: Date;
}

export interface IngestionVersion {
  readonly id: DocumentVersionId;
  readonly status: VersionStatus;
  readonly leaseGeneration: number;
  /** Attempts claimed so far. */
  readonly attempt: number;
}

/** Discovery across workspaces, outside any transaction. */
export interface OutboxSource {
  /** Undispatched entries with `availableAt <= now`, oldest first. */
  listDue(now: Date, limit: number): Promise<readonly OutboxEntry[]>;
}

/** Delivery only: the queue never retries and never decides state. */
export interface JobQueue {
  /** Idempotent by `jobId`: adding an id the queue already holds is a no-op. */
  enqueue(job: {
    readonly jobId: string;
    readonly workspaceId: WorkspaceId;
    readonly versionId: DocumentVersionId;
  }): Promise<void>;
}

/** Steps inside the caller's worker unit of work: nothing here opens a transaction or waits on the network. */
export interface IngestionRepository {
  findVersion(versionId: DocumentVersionId): Promise<IngestionVersion | null>;
  /** Compare-and-set on status and lease generation. `false` when either no longer matches. */
  transition(input: {
    readonly versionId: DocumentVersionId;
    readonly leaseGeneration: number;
    readonly from: VersionStatus;
    readonly to: "queued";
  }): Promise<boolean>;
  /** Same compare-and-set, ending in `failed` with the failure recorded. */
  failVersion(input: {
    readonly versionId: DocumentVersionId;
    readonly leaseGeneration: number;
    readonly from: VersionStatus;
    readonly failure: IngestionFailure;
  }): Promise<boolean>;
  insertOutbox(entry: OutboxEntry): Promise<void>;
  /** `false` when the entry was already dispatched, so only one caller wins. */
  markDispatched(outboxId: OutboxId, now: Date): Promise<boolean>;
}

export type IngestionUnitOfWork = WorkerUnitOfWork<{ ingestion: IngestionRepository }>;
