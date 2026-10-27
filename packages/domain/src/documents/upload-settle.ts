import { DomainError, TransactionOutcomeUnknown } from "../kernel/errors";
import type { DocumentId } from "../kernel/ids";
import type { DocumentSummary } from "./document";
import { StorageError, UploadConflict, UploadRejected } from "./errors";
import type { DeadlineSignal } from "./ports";
import { type Compensation, discardObject, unavailable } from "./upload-compensation";
import type { Verification } from "./verified-body";

// Returns only when the object provably landed (storage failed after the last byte but `head`
// shows it); otherwise throws. The last declared byte reaches storage only after the whole body
// passed, so while `result` is unset the PUT is incomplete and no object should exist. That rests
// on the provider discarding incomplete bodies, so it is not trusted: the key is deleted
// (idempotent) and the reservation released only once the store confirms the delete.
export async function settleFailedPut(
  comp: Compensation,
  verification: Verification,
  declared: number,
  error: unknown,
  signal: DeadlineSignal | undefined,
): Promise<void> {
  // The key is random, so an existing object is not this upload's: never delete or hide it.
  if (error instanceof StorageError && error.code === "storage.conflict") {
    comp.retained();
    throw error;
  }
  if (verification.result === undefined) {
    const { reservation } = await discardObject(comp);
    if (error instanceof UploadRejected) {
      throw new UploadRejected(error.code, reservation, { cause: error });
    }
    // The deadline aborted the store's request before the body source reported it: same cause.
    if (signal?.aborted) throw new UploadRejected("upload.deadline_exceeded", reservation);
    throw unavailable(reservation, error);
  }
  // The outcome of the write is unknown (timeout, lost response) and it may still complete later:
  // ask the store, and never release the reservation on a negative answer.
  const stored = await comp.store.head(comp.storageKey).catch(() => undefined);
  if (stored?.length !== declared) {
    comp.retained();
    throw unavailable("retained", error);
  }
}

// Returns the document only when the failed finalization is proven to have committed.
export async function settleFailedFinalize(
  comp: Compensation,
  documentId: DocumentId,
  error: unknown,
): Promise<DocumentSummary> {
  // Ids or key already used: the object under this key may belong to someone else.
  if (error instanceof UploadConflict) {
    comp.retained();
    throw error;
  }
  // A failed commit can still have committed. The document id is this upload's alone, and the
  // document and its version are written in one transaction, so finding the id means ours committed.
  const committed = await comp.uow
    .run(comp.context, (r) => r.documents.findById(comp.workspaceId, documentId))
    .catch(() => undefined);
  if (committed === undefined) {
    comp.retained(); // unknown: keep object and reservation
    throw error;
  }
  if (committed !== null) return committed;
  // Not found is proof of a rollback only when the repository reported one (a DomainError). After
  // a lost connection or timeout a commit may still be in flight, invisible to this read; deleting
  // then could orphan a committed document, so object and reservation stay for reconciliation.
  // An unknown COMMIT outcome is a DomainError but proves nothing about a rollback.
  if (error instanceof DomainError && !(error instanceof TransactionOutcomeUnknown)) {
    await discardObject(comp);
  } else comp.retained();
  throw error;
}
