// Response shapes of GET /workspaces/{workspaceId}/documents and .../documents/{documentId}.
// Nothing here names storage, hashes or document text; `error.code` is a stable machine code.

export const DOCUMENT_STATUSES = [
  "uploaded",
  "queued",
  "parsing",
  "chunking",
  "processed",
  "ready",
  "failed",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

const DOCUMENT_MIMES = ["application/pdf", "text/markdown", "text/plain"] as const;
type DocumentMime = (typeof DOCUMENT_MIMES)[number];

export interface DocumentResponse {
  readonly id: string;
  readonly displayName: string;
  readonly mime: DocumentMime;
  readonly sizeBytes: number;
  readonly status: DocumentStatus;
  readonly error: { readonly code: string; readonly retryable: boolean } | null;
  readonly createdAt: string;
}

export interface DocumentListResponse {
  readonly documents: readonly DocumentResponse[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  list.some((item) => item === value);

/** Runtime check of an untrusted body; `null` when it is not exactly a `DocumentResponse`. */
export function parseDocumentResponse(value: unknown): DocumentResponse | null {
  if (!isRecord(value) || Object.keys(value).length !== 7) return null;
  const { id, displayName, mime, sizeBytes, status, error, createdAt } = value;
  if (typeof id !== "string" || typeof displayName !== "string") return null;
  if (!oneOf(DOCUMENT_MIMES, mime) || !oneOf(DOCUMENT_STATUSES, status)) return null;
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0) return null;
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return null;
  if (error === null) return { id, displayName, mime, sizeBytes, status, error, createdAt };
  if (!isRecord(error) || Object.keys(error).length !== 2) return null;
  const { code, retryable } = error;
  if (typeof code !== "string" || typeof retryable !== "boolean") return null;
  return { id, displayName, mime, sizeBytes, status, error: { code, retryable }, createdAt };
}

export function parseDocumentListResponse(value: unknown): DocumentListResponse | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value["documents"])) {
    return null;
  }
  const documents: DocumentResponse[] = [];
  for (const item of value["documents"]) {
    const parsed = parseDocumentResponse(item);
    if (parsed === null) return null;
    documents.push(parsed);
  }
  return { documents };
}
