import { DomainError } from "../kernel/errors";

export type StorageErrorCode =
  | "storage.unavailable"
  | "storage.rejected"
  | "storage.conflict"
  | "storage.invalid_key"
  | "storage.invalid_length"
  | "storage.length_mismatch";

// Messages are fixed text and no cause is attached: provider errors can carry endpoints and
// request details. `retryable` is true only when repeating the same call may succeed.
export class StorageError extends DomainError {
  constructor(
    override readonly code: StorageErrorCode,
    readonly retryable: boolean,
  ) {
    super(code, "Object storage operation failed");
  }
}

/** The reservation a finalize relied on is gone (released or swept); the caller must roll back. */
export class UploadReservationMissing extends DomainError {
  constructor() {
    super("upload.reservation_missing", "Upload reservation not found");
  }
}

/** An id or storage key was already used; ids are server-generated, so this is a bug or a replay. */
export class UploadConflict extends DomainError {
  constructor(options?: ErrorOptions) {
    super("upload.conflict", "Upload id already in use", options);
  }
}

export type UploadRejectionCode =
  | "upload.invalid_name"
  | "upload.unsupported_type"
  | "upload.invalid_length"
  | "upload.empty"
  | "upload.too_large"
  | "upload.content_mismatch"
  | "upload.incomplete"
  | "upload.client_disconnected"
  | "upload.idle_timeout"
  | "upload.deadline_exceeded"
  | "upload.quota_documents"
  | "upload.quota_bytes"
  | "storage.unavailable";

/**
 * Whether the pending-upload reservation was removed: `retained` means an object may still exist
 * and the reservation stays discoverable for reconciliation (M1.4). Messages are fixed text.
 */
export type ReservationState = "none" | "released" | "retained";

export class UploadRejected extends DomainError {
  constructor(
    override readonly code: UploadRejectionCode,
    readonly reservation: ReservationState = "none",
    options?: ErrorOptions,
  ) {
    super(code, "Upload rejected", options);
  }
}

export type InterruptionReason = "client_disconnected" | "idle_timeout" | "deadline_exceeded";

/** The request body source gave up for a reason other than the bytes themselves. */
export class UploadInterrupted extends DomainError {
  override readonly code: `upload.${InterruptionReason}`;

  constructor(readonly reason: InterruptionReason) {
    super(`upload.${reason}`, "Upload interrupted");
    this.code = `upload.${reason}`;
  }
}
