import type { DocumentSummary } from "@contextvault/domain";

// The only place a document leaves the API on the read routes: an explicit field list, so a field
// added to the domain type is not exposed by accident.
export function toDocumentResponse(document: DocumentSummary) {
  const { id, displayName, mime, sizeBytes, status, error, createdAt } = document;
  return {
    id,
    displayName,
    mime,
    sizeBytes,
    status,
    error: error === null ? null : { code: error.code, retryable: error.retryable },
    createdAt: createdAt.toISOString(),
  };
}
