import type { StorageKey } from "./storage-key";

export interface StoredObject {
  readonly length: number;
}

/** The part of `AbortSignal` the domain uses (this package has no DOM or Node typings). */
export interface DeadlineSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
}

export interface PutOptions {
  /**
   * Deadline for the whole call. Aborting after the last byte left leaves the outcome unknown (the
   * call rejects with `storage.unavailable` and the object may still land), so the caller must ask
   * `head` and never assume absence.
   */
  readonly signal?: DeadlineSignal;
}

/**
 * Private object storage for document bytes. Keys come only from `documentObjectKey`; no
 * operation yields a URL. Every method fails with `StorageError`, except that a failing `body`
 * rejects `put` with the body's own error. Cancelling a `put` means failing its `body` (a
 * `stream.pipeline` with an `AbortSignal` does this); the adapter then aborts the request.
 */
export interface DocumentStore {
  /**
   * Creates the object, which is immutable from then on: stores exactly `length` bytes (1 to the
   * adapter's maximum) or nothing. A body that ends early, runs long, fails, or is aborted leaves
   * no object. An existing key is never overwritten: the call fails with `storage.conflict` and
   * the stored bytes are untouched. The caller supplies a fresh body for any new attempt.
   */
  put(
    key: StorageKey,
    body: AsyncIterable<Uint8Array>,
    length: number,
    options?: PutOptions,
  ): Promise<void>;
  /** `null` when the object does not exist. */
  head(key: StorageKey): Promise<StoredObject | null>;
  /** Idempotent: deleting a missing object succeeds, so a failed delete can be repeated. */
  delete(key: StorageKey): Promise<void>;
}
