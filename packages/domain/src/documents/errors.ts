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
