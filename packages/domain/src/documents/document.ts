import type { DocumentId } from "../kernel/ids";

export const documentMimes = ["application/pdf", "text/markdown", "text/plain"] as const;
export type DocumentMime = (typeof documentMimes)[number];

export const versionStatuses = [
  "uploaded",
  "queued",
  "parsing",
  "chunking",
  "processed",
  "ready",
  "failed",
] as const;
// `processed` is retired: M1.6 activation writes `ready`; the value stays valid for older rows.
export type VersionStatus = (typeof versionStatuses)[number];

export const isDocumentMime = (value: string): value is DocumentMime =>
  documentMimes.some((mime) => mime === value);
export const isVersionStatus = (value: string): value is VersionStatus =>
  versionStatuses.some((status) => status === value);

/** The latest version's failure: a stable code (never document text) and the worker's verdict. */
export interface DocumentFailure {
  readonly code: string;
  readonly retryable: boolean;
}

/**
 * A finalized document; `status` and `error` are the latest version's (`error` only when it
 * failed). Pending uploads never appear here.
 */
export interface DocumentSummary {
  readonly id: DocumentId;
  readonly displayName: string;
  readonly mime: DocumentMime;
  readonly sizeBytes: number;
  readonly status: VersionStatus;
  readonly error: DocumentFailure | null;
  readonly createdAt: Date;
}

/** Per-workspace ceilings, counted over live documents plus every pending upload. */
export interface UploadQuota {
  readonly maxDocuments: number;
  readonly maxBytes: number;
}

export const uploadQuota: UploadQuota = { maxDocuments: 50, maxBytes: 200 * 1024 * 1024 };

/** Repeated from `packages/contracts` and the SQL check on purpose: the domain imports neither. */
export const maxUploadBytes = 10 * 1024 * 1024;
