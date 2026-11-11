import { type DocumentId, parseDocumentId, parseOutboxId } from "../kernel/ids";
import type { UnitOfWork } from "../kernel/unit-of-work";
import { type Actor, assertCan } from "../workspaces/permissions";
import type { DocumentSummary } from "./document";
import { DocumentNotFound, DocumentNotRetryable } from "./errors";
import type { DocumentRepository, DocumentRetryRepository } from "./upload-ports";

export interface RetryDocumentDeps {
  readonly uow: UnitOfWork<{
    documentRetry: DocumentRetryRepository;
    documents: DocumentRepository;
  }>;
  /** A fresh random UUID for the outbox entry. */
  readonly newId: () => string;
  /** Statement and lock-wait bound of the transaction. Default 10 s. */
  readonly transactionTimeoutMs?: number;
}

const defaultTransactionTimeoutMs = 10_000;

/**
 * Manual retry in one transaction (the repository documents what it does). Not idempotent on
 * purpose: a repeat finds the version queued and is refused, so one request enqueues once. A
 * malformed, absent, deleted or foreign id is `DocumentNotFound`; the stored failure text is never
 * read or returned.
 */
export async function retryDocument(
  deps: RetryDocumentDeps,
  command: { readonly actor: Actor; readonly documentId: string },
): Promise<DocumentSummary> {
  const { actor } = command;
  assertCan(actor, "document.retry");
  let documentId: DocumentId;
  try {
    documentId = parseDocumentId(command.documentId);
  } catch {
    throw new DocumentNotFound();
  }
  const outboxId = parseOutboxId(deps.newId());
  const result = await deps.uow.run(
    { userId: actor.userId, workspaceId: actor.workspaceId },
    async (repos) => {
      const outcome = await repos.documentRetry.retry(actor.workspaceId, documentId, outboxId);
      if (outcome !== "retried") return outcome;
      return repos.documents.findById(actor.workspaceId, documentId);
    },
    { timeoutMs: deps.transactionTimeoutMs ?? defaultTransactionTimeoutMs },
  );
  if (result === "not_found" || result === null) throw new DocumentNotFound();
  if (result === "not_retryable") throw new DocumentNotRetryable();
  return result;
}
