import { type DocumentVersionId, parseOutboxId, type WorkspaceId } from "../kernel/ids";
import { decideFailure, type IngestionFailure, isRunning } from "./lifecycle";
import type { IngestionUnitOfWork } from "./ports";

export interface SettleFailureDeps {
  readonly uow: IngestionUnitOfWork;
  /** A fresh random UUID for the retry's outbox row. */
  readonly newId: () => string;
  /** Statement and lock-wait bound of the transaction. Default 10 s. */
  readonly transactionTimeoutMs?: number;
}

export interface SettleFailureInput {
  readonly workspaceId: WorkspaceId;
  readonly versionId: DocumentVersionId;
  /** The generation this worker claimed; a newer claim makes this call a no-op. */
  readonly leaseGeneration: number;
  readonly failure: IngestionFailure;
  readonly now: Date;
}

export type SettleFailureResult =
  | { readonly outcome: "retry"; readonly availableAt: Date }
  | { readonly outcome: "failed" }
  /** Not running, or claimed again since: another worker owns the version, nothing was written. */
  | { readonly outcome: "stale" };

/**
 * Applies the retry policy in one transaction: either the version returns to `queued` together
 * with a new outbox row due after the backoff, or it ends `failed` with the failure recorded.
 */
export function settleFailure(
  deps: SettleFailureDeps,
  input: SettleFailureInput,
): Promise<SettleFailureResult> {
  const { versionId, leaseGeneration, failure, now } = input;
  return deps.uow.run(
    { workspaceId: input.workspaceId },
    async ({ ingestion }): Promise<SettleFailureResult> => {
      const version = await ingestion.findVersion(versionId);
      if (!version || version.leaseGeneration !== leaseGeneration || !isRunning(version.status)) {
        return { outcome: "stale" };
      }
      const from = version.status;
      const decision = decideFailure(version.attempt, failure.retryable);
      if (decision.action === "fail") {
        const done = await ingestion.failVersion({ versionId, leaseGeneration, from, failure });
        return done ? { outcome: "failed" } : { outcome: "stale" };
      }
      const moved = await ingestion.transition({ versionId, leaseGeneration, from, to: "queued" });
      if (!moved) return { outcome: "stale" };
      const availableAt = new Date(now.getTime() + decision.delayMs);
      await ingestion.insertOutbox({
        id: parseOutboxId(deps.newId()),
        workspaceId: input.workspaceId,
        versionId,
        availableAt,
      });
      return { outcome: "retry", availableAt };
    },
    { timeoutMs: deps.transactionTimeoutMs ?? 10_000 },
  );
}
