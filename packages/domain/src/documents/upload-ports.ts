import type { DocumentId, DocumentVersionId, OutboxId, UserId, WorkspaceId } from "../kernel/ids";
import type { DocumentMime, DocumentSummary, UploadQuota } from "./document";
import type { StorageKey } from "./storage-key";

export interface PendingUpload {
  readonly versionId: DocumentVersionId;
  readonly storageKey: StorageKey;
  readonly declaredBytes: number;
  readonly createdAt: Date;
}

export type QuotaRefusal = { readonly outcome: "quota"; readonly reason: "documents" | "bytes" };

export interface ReserveUploadInput {
  readonly workspaceId: WorkspaceId;
  readonly versionId: DocumentVersionId;
  readonly storageKey: StorageKey;
  readonly declaredBytes: number;
  readonly createdBy: UserId;
}

export interface FinalizeUploadInput {
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  readonly versionId: DocumentVersionId;
  /** The id of the `process_version` outbox entry written with the version. */
  readonly outboxId: OutboxId;
  readonly storageKey: StorageKey;
  readonly displayName: string;
  readonly mime: DocumentMime;
  readonly sizeBytes: number;
  /** 32 bytes. */
  readonly contentSha256: Uint8Array;
  readonly createdBy: UserId;
}

export type ReserveResult = { readonly outcome: "reserved" } | QuotaRefusal;

export type FinalizeResult =
  | { readonly outcome: "created"; readonly document: DocumentSummary }
  | { readonly outcome: "duplicate"; readonly document: DocumentSummary }
  | QuotaRefusal;

/**
 * Persistence primitives of the upload protocol. Each call is one step inside the caller's unit of
 * work: nothing here opens a transaction, and no call may wait on the network. The quota-sensitive
 * calls serialise per workspace (advisory transaction lock), so concurrent callers take turns.
 */
export interface UploadRepository {
  /**
   * Records the intent to store one object. Counts against `quota` from now until released or
   * finalized, whatever its age, so an abandoned reservation can never hide storage in use.
   */
  reserveUpload(input: ReserveUploadInput, quota: UploadQuota): Promise<ReserveResult>;
  /**
   * Turns a reservation into a document with its first version (`uploaded`) and one outbox entry
   * for it, and removes the reservation, in the caller's transaction. Identical live content in the workspace returns
   * `duplicate` and costs no quota. On `duplicate` and `quota` nothing is written and the
   * reservation stays, so the caller deletes the object first and then calls `releaseUpload`.
   * When it would create a document, it throws `UploadReservationMissing` if the reservation
   * (same id, key, workspace) is gone, rolling the unit of work back. `duplicate` and `quota`
   * are answered without looking at the reservation, so releasing a missing one returns `false`.
   */
  finalizeUpload(input: FinalizeUploadInput, quota: UploadQuota): Promise<FinalizeResult>;
  /** The acting user's own reservation. `false` when none exists. */
  releaseUpload(workspaceId: WorkspaceId, versionId: DocumentVersionId): Promise<boolean>;
  /** Reservations older than `createdBefore`, oldest first: the objects that may need deleting. */
  listPendingUploads(
    workspaceId: WorkspaceId,
    createdBefore: Date,
    limit: number,
  ): Promise<readonly PendingUpload[]>;
}

export interface DocumentRepository {
  /** Newest first. */
  list(workspaceId: WorkspaceId, limit: number): Promise<readonly DocumentSummary[]>;
  findById(workspaceId: WorkspaceId, documentId: DocumentId): Promise<DocumentSummary | null>;
}

/** Incremental SHA-256; the domain does not import `node:crypto`, so an adapter supplies it. */
export interface Sha256 {
  update(chunk: Uint8Array): void;
  /** 32 bytes. */
  digest(): Uint8Array;
}

export interface UploadServices {
  /** A fresh random UUID. */
  newId(): string;
  newSha256(): Sha256;
}
