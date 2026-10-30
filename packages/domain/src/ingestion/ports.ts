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

/** What a writer asks for: PostgreSQL stamps `available_at` as its own `now()` plus the delay. */
export interface NewOutboxEntry {
  readonly id: OutboxId;
  readonly workspaceId: WorkspaceId;
  readonly versionId: DocumentVersionId;
  readonly delayMs: number;
}

/** The generation to fence every later write with, and the attempt this claim consumed. */
export interface ClaimedVersion {
  readonly leaseGeneration: number;
  readonly attempt: number;
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
  /** Undispatched entries due by the database clock, oldest first. */
  listDue(limit: number): Promise<readonly OutboxEntry[]>;
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
  /**
   * Atomically moves `uploaded` or `queued` to `parsing`, bumping the lease generation and
   * counting the attempt. `null` when nothing was claimed: the version is not claimable, the
   * document is deleted, attempts are spent, or a live outbox entry is still scheduled in the
   * future of the database clock (an early redelivery must not skip the retry backoff). A refusal
   * changes nothing. A claim also marks the version's live outbox entry dispatched, in the same
   * statement: the delivery consumed it, so a later retry always gets a fresh entry and job id.
   */
  claim(input: { readonly versionId: DocumentVersionId }): Promise<ClaimedVersion | null>;
  /** Renews the lease of a running version. `false` once the generation or status moved on. */
  heartbeat(input: {
    readonly versionId: DocumentVersionId;
    readonly leaseGeneration: number;
  }): Promise<boolean>;
  /** Compare-and-set on status and lease generation. `false` when either no longer matches. */
  transition(input: {
    readonly versionId: DocumentVersionId;
    readonly leaseGeneration: number;
    readonly from: VersionStatus;
    readonly to: "queued" | "chunking" | "processed";
  }): Promise<boolean>;
  /** Same compare-and-set, ending in `failed` with the failure recorded. */
  failVersion(input: {
    readonly versionId: DocumentVersionId;
    readonly leaseGeneration: number;
    readonly from: VersionStatus;
    readonly failure: IngestionFailure;
  }): Promise<boolean>;
  /** A live entry for the same version already schedules it, so a second one is not inserted. */
  insertOutbox(entry: NewOutboxEntry): Promise<void>;
  /** Pushes an undispatched entry back so a failing one yields to newer work. `false` when it was dispatched. */
  deferOutbox(outboxId: OutboxId, delayMs: number): Promise<boolean>;
  /** `false` when the entry was already dispatched, so only one caller wins. */
  markDispatched(outboxId: OutboxId): Promise<boolean>;
}

export type IngestionUnitOfWork = WorkerUnitOfWork<{ ingestion: IngestionRepository }>;
