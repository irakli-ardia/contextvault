import { type DocumentVersionId, parseOutboxId, type WorkspaceId } from "../kernel/ids";
import { decideFailure, isRunning } from "./lifecycle";
import { leaseDurationMs } from "./recovery-policy";
import type { RecoveryUnitOfWork } from "./recovery-ports";

export interface RecoverExpiredLeaseDeps {
  readonly uow: RecoveryUnitOfWork;
  /** A fresh random UUID for the retry's outbox row. */
  readonly newId: () => string;
  /** Statement and lock-wait bound of the transaction. Default 10 s. */
  readonly transactionTimeoutMs?: number;
}

export interface RecoverExpiredLeaseInput {
  readonly workspaceId: WorkspaceId;
  readonly versionId: DocumentVersionId;
  readonly observedGeneration: number;
}

export type RecoverExpiredLeaseResult =
  | { readonly outcome: "retry"; readonly delayMs: number }
  | { readonly outcome: "failed" }
  /** Nothing eligible: the lease is live, or the version moved on since it was observed. */
  | { readonly outcome: "skipped" };

/**
 * One transaction: the expiry bumps the lease generation (fencing out the dead worker), then the
 * version is re-queued with a fresh outbox row or failed, per the existing retry policy. The
 * business attempt is never incremented. Any later failure rolls the generation bump back too.
 * A fenced write that loses right after our own bump is a broken invariant, so it throws.
 */
export function recoverExpiredLease(
  deps: RecoverExpiredLeaseDeps,
  input: RecoverExpiredLeaseInput,
): Promise<RecoverExpiredLeaseResult> {
  const { workspaceId, versionId, observedGeneration } = input;
  return deps.uow.run(
    { workspaceId },
    async ({ recovery, ingestion }): Promise<RecoverExpiredLeaseResult> => {
      const expired = await recovery.expireLease({
        versionId,
        observedGeneration,
        leaseDurationMs,
      });
      if (!expired) return { outcome: "skipped" };
      const { status: from, attempt, leaseGeneration } = expired;
      if (!isRunning(from)) {
        throw new Error(`expired lease of ${versionId} reported non-running status ${from}`);
      }
      const decision = decideFailure(attempt, true);
      if (decision.action === "fail") {
        const done = await ingestion.failVersion({
          versionId,
          leaseGeneration,
          from,
          failure: { stage: from, code: "lease.expired", retryable: true },
        });
        if (!done) throw new Error(`fenced failVersion lost for ${versionId}`);
        return { outcome: "failed" };
      }
      const moved = await ingestion.transition({ versionId, leaseGeneration, from, to: "queued" });
      if (!moved) throw new Error(`fenced transition lost for ${versionId}`);
      await ingestion.insertOutbox({
        id: parseOutboxId(deps.newId()),
        workspaceId,
        versionId,
        delayMs: decision.delayMs,
      });
      return { outcome: "retry", delayMs: decision.delayMs };
    },
    { timeoutMs: deps.transactionTimeoutMs ?? 10_000 },
  );
}
