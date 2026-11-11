import { type DocumentId, parseDocumentId } from "../kernel/ids";
import type { UnitOfWork } from "../kernel/unit-of-work";
import { type Actor, assertCan } from "../workspaces/permissions";
import { type DocumentSummary, uploadQuota } from "./document";
import { DocumentNotFound } from "./errors";
import type { DocumentRepository } from "./upload-ports";

export interface ReadDocumentsDeps {
  readonly uow: UnitOfWork<{ documents: DocumentRepository }>;
}

/** The live-document quota, so one page is every document the workspace can hold. */
export const maxListedDocuments = uploadQuota.maxDocuments;

/** Newest first, soft-deleted documents excluded by the repository. No cursor: bounded by quota. */
export async function listDocuments(
  deps: ReadDocumentsDeps,
  actor: Actor,
): Promise<readonly DocumentSummary[]> {
  assertCan(actor, "document.read");
  return deps.uow.run({ userId: actor.userId, workspaceId: actor.workspaceId }, (repos) =>
    repos.documents.list(actor.workspaceId, maxListedDocuments),
  );
}

/** A malformed, absent, deleted or foreign id is one answer: `DocumentNotFound`. */
export async function getDocument(
  deps: ReadDocumentsDeps,
  actor: Actor,
  rawDocumentId: string,
): Promise<DocumentSummary> {
  assertCan(actor, "document.read");
  let documentId: DocumentId;
  try {
    documentId = parseDocumentId(rawDocumentId);
  } catch {
    throw new DocumentNotFound();
  }
  const found = await deps.uow.run(
    { userId: actor.userId, workspaceId: actor.workspaceId },
    (repos) => repos.documents.findById(actor.workspaceId, documentId),
  );
  if (found === null) throw new DocumentNotFound();
  return found;
}
