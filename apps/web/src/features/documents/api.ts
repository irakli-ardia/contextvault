import {
  type DocumentListResponse,
  type DocumentResponse,
  parseDocumentListResponse,
  parseDocumentResponse,
} from "@contextvault/contracts";
import { expectShape, request } from "../../lib/http-client";

// Ids are interpolated into the path, so they are encoded: no id can add a segment or a query.
const base = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/documents`;

export async function listDocuments(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<DocumentListResponse> {
  return expectShape(await request(base(workspaceId), { signal }), parseDocumentListResponse);
}

export async function getDocument(
  workspaceId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<DocumentResponse> {
  const path = `${base(workspaceId)}/${encodeURIComponent(documentId)}`;
  return expectShape(await request(path, { signal }), parseDocumentResponse);
}

export async function retryDocument(
  workspaceId: string,
  documentId: string,
): Promise<DocumentResponse> {
  const path = `${base(workspaceId)}/${encodeURIComponent(documentId)}/retry`;
  return expectShape(await request(path, { method: "POST" }), parseDocumentResponse);
}

/** Idempotent: deleting a document that is already gone also succeeds. */
export async function deleteDocument(workspaceId: string, documentId: string): Promise<void> {
  await request(`${base(workspaceId)}/${encodeURIComponent(documentId)}`, { method: "DELETE" });
}
