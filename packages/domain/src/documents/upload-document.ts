import { TransactionOutcomeUnknown } from "../kernel/errors";
import {
  type DocumentVersionId,
  parseDocumentId,
  parseDocumentVersionId,
  type WorkspaceId,
} from "../kernel/ids";
import type { UnitOfWork } from "../kernel/unit-of-work";
import { type Actor, assertCan } from "../workspaces/permissions";
import {
  type DocumentSummary,
  isDocumentMime,
  maxUploadBytes,
  type UploadQuota,
  uploadQuota,
} from "./document";
import { UploadRejected } from "./errors";
import { sanitizeFileName } from "./filename";
import type { DeadlineSignal, DocumentStore } from "./ports";
import { documentObjectKey } from "./storage-key";
import {
  type Compensation,
  discardObject,
  retainedNotifier,
  unavailable,
} from "./upload-compensation";
import type {
  DocumentRepository,
  QuotaRefusal,
  UploadRepository,
  UploadServices,
} from "./upload-ports";
import { settleFailedFinalize, settleFailedPut } from "./upload-settle";
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
  /**
   * The deadline for the whole operation. The caller's body source must fail on it; the store's
   * `put` is aborted by it. Reservation, finalization and cleanup are never cancelled.
   */
  readonly signal?: DeadlineSignal;
}

export interface UploadDocumentDeps {
  readonly uow: UnitOfWork<{ uploads: UploadRepository; documents: DocumentRepository }>;
  readonly store: DocumentStore;
  readonly services: UploadServices;
  readonly quota?: UploadQuota;
  /** Statement and lock-wait bound of each of this use case's transactions. Default 10 s. */
  readonly transactionTimeoutMs?: number;
  /**
   * Called once when a reservation outlives the call (object possibly present, M1.4 reconciles).
   * Observability only: it receives no content and a throwing hook changes nothing.
   */
  readonly onRetained?: (event: { workspaceId: WorkspaceId; versionId: DocumentVersionId }) => void;
}

export interface UploadDocumentResult {
  readonly outcome: "created" | "duplicate";
  readonly document: DocumentSummary;
}

const defaultTransactionTimeoutMs = 10_000;

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
  if (command.signal?.aborted) throw new UploadRejected("upload.deadline_exceeded");
  const { store, services } = deps;
  const quota = deps.quota ?? uploadQuota;
  // Every transaction here, compensation included, is bounded so a stuck database call cannot
  // outlive the caller's deadline by more than a few statements. A timeout is a rollback.
  const timeoutMs = deps.transactionTimeoutMs ?? defaultTransactionTimeoutMs;
  const uow: UploadDocumentDeps["uow"] = {
    run: (context, work, options) => deps.uow.run(context, work, { timeoutMs, ...options }),
  };

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
    retained: retainedNotifier(deps.onRetained, { workspaceId: actor.workspaceId, versionId }),
  };

  let reserved: Awaited<ReturnType<UploadRepository["reserveUpload"]>>;
  try {
    reserved = await uow.run(context, (r) =>
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
  } catch (error) {
    // Nothing is written to storage on any failure here. Only a lost COMMIT acknowledgement leaves
    // the row possibly durable; it stays (no object exists to clean) and is reported for M1.4.
    if (error instanceof TransactionOutcomeUnknown) comp.retained();
    throw error;
  }
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
    await store.put(
      storageKey,
      body,
      command.declaredBytes,
      command.signal === undefined ? {} : { signal: command.signal },
    );
  } catch (error) {
    await settleFailedPut(comp, verification, command.declaredBytes, error, command.signal);
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
