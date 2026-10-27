import { createHash, randomUUID } from "node:crypto";
import {
  documentObjectKey,
  type FinalizeUploadInput,
  parseDocumentId,
  parseDocumentVersionId,
  type ReserveUploadInput,
  type UploadQuota,
  type UserId,
  type WorkspaceId,
} from "@contextvault/domain";
import type { TenantFixture } from "./tenant-fixture";

export const roomy: UploadQuota = { maxDocuments: 50, maxBytes: 200 * 1024 * 1024 };

export interface Upload {
  readonly workspaceId: WorkspaceId;
  readonly createdBy: UserId;
  readonly documentId: ReturnType<typeof parseDocumentId>;
  readonly versionId: ReturnType<typeof parseDocumentVersionId>;
  readonly storageKey: ReturnType<typeof documentObjectKey>;
}

export function newUpload(workspaceId: WorkspaceId, createdBy: UserId): Upload {
  const documentId = parseDocumentId(randomUUID());
  const versionId = parseDocumentVersionId(randomUUID());
  const storageKey = documentObjectKey(workspaceId, documentId, versionId);
  return { workspaceId, createdBy, documentId, versionId, storageKey };
}

export const sha256 = (seed: string): Buffer => createHash("sha256").update(seed).digest();

export const reserveInput = (u: Upload, declaredBytes = 100): ReserveUploadInput => ({
  workspaceId: u.workspaceId,
  versionId: u.versionId,
  storageKey: u.storageKey,
  declaredBytes,
  createdBy: u.createdBy,
});

export const finalizeInput = (
  u: Upload,
  seed: string = u.documentId,
  sizeBytes = 100,
): FinalizeUploadInput => ({
  workspaceId: u.workspaceId,
  documentId: u.documentId,
  versionId: u.versionId,
  storageKey: u.storageKey,
  displayName: "report.pdf",
  mime: "application/pdf",
  sizeBytes,
  contentSha256: sha256(seed),
  createdBy: u.createdBy,
});

/** A finalized document through the repositories (two transactions, like the upload protocol). */
export async function seedDocument(
  fx: TenantFixture,
  workspaceId: WorkspaceId,
  userId: UserId,
  seed?: string,
  sizeBytes = 100,
): Promise<Upload> {
  const upload = newUpload(workspaceId, userId);
  const context = { userId, workspaceId };
  const { unitOfWork } = fx.persistence;
  await unitOfWork.run(context, (r) => r.uploads.reserveUpload(reserveInput(upload), roomy));
  const result = await unitOfWork.run(context, (r) =>
    r.uploads.finalizeUpload(finalizeInput(upload, seed, sizeBytes), roomy),
  );
  if (result.outcome !== "created") throw new Error("seed was not created");
  return upload;
}
