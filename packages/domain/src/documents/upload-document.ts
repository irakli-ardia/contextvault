import { DomainError } from "../kernel/errors";
import { type DocumentId, parseDocumentId, parseDocumentVersionId } from "../kernel/ids";
import type { UnitOfWork } from "../kernel/unit-of-work";
import { type Actor, assertCan } from "../workspaces/permissions";
import {
  type DocumentSummary,
  isDocumentMime,
  maxUploadBytes,
  type UploadQuota,
  uploadQuota,
} from "./document";
import { StorageError, UploadConflict, UploadRejected } from "./errors";
import { sanitizeFileName } from "./filename";
import type { DocumentStore } from "./ports";
import { documentObjectKey } from "./storage-key";
import { type Compensation, discardObject, unavailable } from "./upload-compensation";
import type {
  DocumentRepository,
  QuotaRefusal,
  UploadRepository,
  UploadServices,
} from "./upload-ports";
import { type Verification, verifiedBody } from "./verified-body";

export interface UploadDocumentCommand {
  /** From `resolveActor`: the workspace and user are verified, never taken from the client. */
  readonly actor: Actor;
  /** The decoded `X-Filename`; sanitised here. */
  readonly fileName: string;
  /** The declared content type, canonical and lower case. */
  readonly contentType: string;
  /** The declared `Content-Length`. */
  readonly declaredBytes: number;
  /** The request body; it fails (or ends) when the client goes away. */
  readonly body: AsyncIterable<Uint8Array>;
}

export interface UploadDocumentDeps {
  readonly uow: UnitOfWork<{ uploads: UploadRepository; documents: DocumentRepository }>;
  readonly store: DocumentStore;
  readonly services: UploadServices;
  readonly quota?: UploadQuota;
}

export interface UploadDocumentResult {
  readonly outcome: "created" | "duplicate";
  readonly document: DocumentSummary;
}

const quotaRejection = (refusal: QuotaRefusal, reservation: "none" | "released" | "retained") =>
  new UploadRejected(
    refusal.reason === "documents" ? "upload.quota_documents" : "upload.quota_bytes",
    reservation,
  );

function validate(command: UploadDocumentCommand) {
  const { declaredBytes } = command;
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
    throw new UploadRejected("upload.invalid_length");
  }
  if (declaredBytes === 0) throw new UploadRejected("upload.empty");
  if (declaredBytes > maxUploadBytes) throw new UploadRejected("upload.too_large");
  if (!isDocumentMime(command.contentType)) throw new UploadRejected("upload.unsupported_type");
  const { name, mime } = sanitizeFileName(command.fileName);
  if (mime !== command.contentType) throw new UploadRejected("upload.unsupported_type");
  return { name, mime };
}

/**
 * Reserve (tx 1) → stream to private storage with verification → finalize (tx 2). No transaction
 * is open during storage I/O. Every failure after the reservation is compensated; the reservation
 * is dropped only once its object is known absent or confirmed deleted (`UploadRejected.reservation`
 * reports which). A reservation that outlives its call is the M1.4 sweeper's input.
 */
export async function uploadDocument(
  deps: UploadDocumentDeps,
  command: UploadDocumentCommand,
): Promise<UploadDocumentResult> {
  const { actor } = command;
  assertCan(actor, "document.upload");
  const { name, mime } = validate(command);
  const { uow, store, services } = deps;
  const quota = deps.quota ?? uploadQuota;

  const documentId = parseDocumentId(services.newId());
  const versionId = parseDocumentVersionId(services.newId());
  const storageKey = documentObjectKey(actor.workspaceId, documentId, versionId);
  const context = { userId: actor.userId, workspaceId: actor.workspaceId };
  const comp: Compensation = {
    uow,
    store,
    context,
    workspaceId: actor.workspaceId,
    versionId,
    storageKey,
  };

  const reserved = await uow.run(context, (r) =>
    r.uploads.reserveUpload(
      {
        workspaceId: actor.workspaceId,
        versionId,
        storageKey,
        declaredBytes: command.declaredBytes,
        createdBy: actor.userId,
      },
      quota,
    ),
  );
  if (reserved.outcome === "quota") throw quotaRejection(reserved, "none");

  const verification: Verification = {};
  const body = verifiedBody(
    command.body,
    command.declaredBytes,
    mime,
    services.newSha256(),
    verification,
  );
  try {
    await store.put(storageKey, body, command.declaredBytes);
  } catch (error) {
    await settleFailedPut(comp, verification, command.declaredBytes, error);
  }
  const verified = verification.result;
  if (verified === undefined) throw new Error("Stored body was never verified");

  let finalized: Awaited<ReturnType<UploadRepository["finalizeUpload"]>>;
  try {
    finalized = await uow.run(context, (r) =>
      r.uploads.finalizeUpload(
        {
          workspaceId: actor.workspaceId,
          documentId,
          versionId,
          storageKey,
          displayName: name,
          mime,
          sizeBytes: command.declaredBytes,
          contentSha256: verified.sha256,
          createdBy: actor.userId,
        },
        quota,
      ),
    );
  } catch (error) {
    return settleFailedFinalize(deps, comp, documentId, error);
  }

  if (finalized.outcome === "created") return finalized;
  // Duplicate or over quota: this upload's object is surplus. Only its own key is deleted.
  const discarded = await discardObject(comp);
  if (finalized.outcome === "quota") throw quotaRejection(finalized, discarded.reservation);
  if (!discarded.deleted) throw unavailable("retained");
  return finalized;
}

// Returns only when the object provably landed (storage failed after the last byte but `head`
// shows it); otherwise throws. The last declared byte reaches storage only after the whole body
// passed, so while `result` is unset the PUT is incomplete and no object should exist. That rests
// on the provider discarding incomplete bodies, so it is not trusted: the key is deleted
// (idempotent) and the reservation released only once the store confirms the delete.
async function settleFailedPut(
  comp: Compensation,
  verification: Verification,
  declared: number,
  error: unknown,
): Promise<void> {
  // The key is random, so an existing object is not this upload's: never delete or hide it.
  if (error instanceof StorageError && error.code === "storage.conflict") throw error;
  if (verification.result === undefined) {
    const { reservation } = await discardObject(comp);
    if (error instanceof UploadRejected) {
      throw new UploadRejected(error.code, reservation, { cause: error });
    }
    throw unavailable(reservation, error);
  }
  // The outcome of the write is unknown (timeout, lost response) and it may still complete later:
  // ask the store, and never release the reservation on a negative answer.
  const stored = await comp.store.head(comp.storageKey).catch(() => undefined);
  if (stored?.length !== declared) throw unavailable("retained", error);
}

async function settleFailedFinalize(
  deps: UploadDocumentDeps,
  comp: Compensation,
  documentId: DocumentId,
  error: unknown,
): Promise<UploadDocumentResult> {
  // Ids or key already used: the object under this key may belong to someone else.
  if (error instanceof UploadConflict) throw error;
  // A failed commit can still have committed. The document id is this upload's alone, and the
  // document and its version are written in one transaction, so finding the id means ours committed.
  const committed = await deps.uow
    .run(comp.context, (r) => r.documents.findById(comp.workspaceId, documentId))
    .catch(() => undefined);
  if (committed === undefined) throw error; // unknown: keep object and reservation
  if (committed !== null) return { outcome: "created", document: committed };
  // Not found is proof of a rollback only when the repository reported one (a DomainError). After
  // a lost connection or timeout a commit may still be in flight, invisible to this read; deleting
  // then could orphan a committed document, so object and reservation stay for reconciliation.
  if (error instanceof DomainError) await discardObject(comp);
  throw error;
}
