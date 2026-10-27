import type { DocumentVersionId, WorkspaceId } from "../kernel/ids";
import type { TenantContext, UnitOfWork } from "../kernel/unit-of-work";
import { type ReservationState, UploadRejected } from "./errors";
import type { DocumentStore } from "./ports";
import type { StorageKey } from "./storage-key";
import type { DocumentRepository, UploadRepository } from "./upload-ports";

export interface Compensation {
  readonly uow: UnitOfWork<{ uploads: UploadRepository; documents: DocumentRepository }>;
  readonly store: DocumentStore;
  readonly context: TenantContext;
  readonly workspaceId: WorkspaceId;
  readonly versionId: DocumentVersionId;
  readonly storageKey: StorageKey;
  /** Reports that the reservation outlives this call. Idempotent per upload; never throws. */
  readonly retained: () => void;
}

/** Wraps the caller's hook so it fires at most once and can never alter the upload's outcome. */
export function retainedNotifier(
  hook: ((event: { workspaceId: WorkspaceId; versionId: DocumentVersionId }) => void) | undefined,
  event: { workspaceId: WorkspaceId; versionId: DocumentVersionId },
): () => void {
  let sent = false;
  return () => {
    if (sent) return;
    sent = true;
    try {
      hook?.(event);
    } catch {
      // Observability must not change compensation or the result.
    }
  };
}

const attempt = (work: () => Promise<unknown>): Promise<boolean> =>
  work().then(
    () => true,
    () => false,
  );

/** Drops the reservation (its own short transaction). `false` only when that transaction failed. */
const releaseReservation = (c: Compensation): Promise<boolean> =>
  attempt(() => c.uow.run(c.context, (r) => r.uploads.releaseUpload(c.workspaceId, c.versionId)));

/**
 * Removes this upload's own object, then its reservation. `deleted` is true only when the store
 * confirmed the delete (idempotent, so success also covers an object that never existed). The
 * reservation is never released unless the object is gone, so a failed delete stays discoverable.
 */
export async function discardObject(
  c: Compensation,
): Promise<{ deleted: boolean; reservation: ReservationState }> {
  if (!(await attempt(() => c.store.delete(c.storageKey)))) {
    c.retained();
    return { deleted: false, reservation: "retained" };
  }
  if (await releaseReservation(c)) return { deleted: true, reservation: "released" };
  c.retained();
  return { deleted: true, reservation: "retained" };
}

export const unavailable = (reservation: ReservationState, cause?: unknown): UploadRejected =>
  new UploadRejected("storage.unavailable", reservation, { cause });
