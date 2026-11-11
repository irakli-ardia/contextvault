import { type DocumentId, parseDocumentId } from "../kernel/ids";
import type { UnitOfWork } from "../kernel/unit-of-work";
import { type Actor, assertCan } from "../workspaces/permissions";
import { DocumentNotFound } from "./errors";
import type { DocumentDeletionRepository } from "./upload-ports";

export interface DeleteDocumentDeps {
  readonly uow: UnitOfWork<{ documentDeletion: DocumentDeletionRepository }>;
  /** Statement and lock-wait bound of the transaction. Default 10 s. */
  readonly transactionTimeoutMs?: number;
}

export type DeleteDocumentOutcome = "deleted" | "already_deleted";

const defaultTransactionTimeoutMs = 10_000;

/**
 * Soft delete in one transaction (the repository documents what it does). Idempotent: repeating it
 * answers `already_deleted`. Objects and derived rows stay stored, unreachable through the
 * document, until the worker's purge removes them after the retention period.
 */
export async function deleteDocument(
  deps: DeleteDocumentDeps,
  command: { readonly actor: Actor; readonly documentId: string },
): Promise<DeleteDocumentOutcome> {
  const { actor } = command;
  assertCan(actor, "document.delete");
  let documentId: DocumentId;
  try {
    documentId = parseDocumentId(command.documentId);
  } catch {
    throw new DocumentNotFound();
  }
  const outcome = await deps.uow.run(
    { userId: actor.userId, workspaceId: actor.workspaceId },
    (repos) => repos.documentDeletion.softDelete(actor.workspaceId, documentId),
    { timeoutMs: deps.transactionTimeoutMs ?? defaultTransactionTimeoutMs },
  );
  if (outcome === "not_found") throw new DocumentNotFound();
  return outcome;
}
