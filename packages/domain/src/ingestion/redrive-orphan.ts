import { type DocumentVersionId, parseOutboxId, type WorkspaceId } from "../kernel/ids";
import type { OrphanUnitOfWork } from "./orphan-ports";
import { outboxHistoryCap, redriveCooldownMs } from "./recovery-policy";

export interface RedriveOrphanDeps {
  readonly uow: OrphanUnitOfWork;
  /** A fresh random UUID for the new outbox row. */
  readonly newId: () => string;
  /** Statement and lock-wait bound of the transaction. Default 10 s. */
  readonly transactionTimeoutMs?: number;
}

export interface RedriveOrphanInput {
  readonly workspaceId: WorkspaceId;
  readonly versionId: DocumentVersionId;
}

export type RedriveOrphanResult =
  | { readonly outcome: "redriven" }
  /** Not an orphan, or still cooling down. */
  | { readonly outcome: "skipped" };

/**
 * One transaction: an unclaimed version with no live outbox entry that has been idle past its
 * cooldown gets one immediately due entry. Status, attempt and lease generation never change.
 */
export function redriveOrphan(
  deps: RedriveOrphanDeps,
  input: RedriveOrphanInput,
): Promise<RedriveOrphanResult> {
  const { workspaceId, versionId } = input;
  return deps.uow.run(
    { workspaceId },
    async ({ orphan, ingestion }): Promise<RedriveOrphanResult> => {
      const snapshot = await orphan.lockOrphan({ versionId, historyCap: outboxHistoryCap });
      if (!snapshot) return { outcome: "skipped" };
      if (snapshot.idleMs < redriveCooldownMs(snapshot.outboxRows, snapshot.attempt)) {
        return { outcome: "skipped" };
      }
      await ingestion.insertOutbox({
        id: parseOutboxId(deps.newId()),
        workspaceId,
        versionId,
        delayMs: 0,
      });
      return { outcome: "redriven" };
    },
    { timeoutMs: deps.transactionTimeoutMs ?? 10_000 },
  );
}
