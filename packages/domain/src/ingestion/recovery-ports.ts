import type { VersionStatus } from "../documents/document";
import type { DocumentVersionId, WorkspaceId } from "../kernel/ids";
import type { IngestionRepository, WorkerUnitOfWork } from "./ports";

/** What `expireLease` saw before it bumped the generation, plus the new generation. */
export interface ExpiredLease {
  /** The running status the version was in. */
  readonly status: VersionStatus;
  /** Business attempts claimed so far; recovery never changes it. */
  readonly attempt: number;
  /** The generation after the bump: fence every later write with it. */
  readonly leaseGeneration: number;
}

/** Steps inside the caller's worker unit of work. */
export interface RecoveryRepository {
  /**
   * Atomically bumps the lease generation of a running version whose lease expired, when its
   * generation is still `observedGeneration`. `null` when stale or ineligible (not running, lease
   * live, claimed again, document deleted); a refusal changes nothing.
   */
  expireLease(input: {
    readonly versionId: DocumentVersionId;
    readonly observedGeneration: number;
    readonly leaseDurationMs: number;
  }): Promise<ExpiredLease | null>;
}

export interface ExpiredLeaseCandidate {
  readonly workspaceId: WorkspaceId;
  readonly versionId: DocumentVersionId;
  readonly observedGeneration: number;
}

/** Discovery across workspaces, outside any transaction. */
export interface RecoverySource {
  listExpiredLeases(
    limit: number,
    leaseDurationMs: number,
  ): Promise<readonly ExpiredLeaseCandidate[]>;
}

export type RecoveryUnitOfWork = WorkerUnitOfWork<{
  recovery: RecoveryRepository;
  ingestion: IngestionRepository;
}>;
