import type { DocumentId } from "../kernel/ids";

export const documentMimes = ["application/pdf", "text/markdown", "text/plain"] as const;
export type DocumentMime = (typeof documentMimes)[number];

export const versionStatuses = [
  "uploaded",
  "queued",
  "parsing",
  "chunking",
  "ready",
  "failed",
] as const;
export type VersionStatus = (typeof versionStatuses)[number];

export const isDocumentMime = (value: string): value is DocumentMime =>
  documentMimes.some((mime) => mime === value);
export const isVersionStatus = (value: string): value is VersionStatus =>
  versionStatuses.some((status) => status === value);

/** A finalized document; `status` is the latest version's. Pending uploads never appear here. */
export interface DocumentSummary {
  readonly id: DocumentId;
  readonly displayName: string;
  readonly mime: DocumentMime;
  readonly sizeBytes: number;
  readonly status: VersionStatus;
  readonly createdAt: Date;
}

/** Per-workspace ceilings, counted over live documents plus every pending upload. */
export interface UploadQuota {
  readonly maxDocuments: number;
  readonly maxBytes: number;
}

export const uploadQuota: UploadQuota = { maxDocuments: 50, maxBytes: 200 * 1024 * 1024 };
