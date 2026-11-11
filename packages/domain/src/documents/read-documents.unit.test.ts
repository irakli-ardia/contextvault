import { describe, expect, it } from "vitest";
import { parseDocumentId, parseUserId, parseWorkspaceId } from "../kernel/ids";
import type { UnitOfWork } from "../kernel/unit-of-work";
import { roles } from "../workspaces/workspace";
import type { DocumentSummary } from "./document";
import { DocumentNotFound } from "./errors";
import { getDocument, listDocuments, maxListedDocuments } from "./read-documents";
import type { DocumentRepository } from "./upload-ports";

const workspaceId = parseWorkspaceId("0b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f");
const userId = parseUserId("1b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f");
const documentId = "3b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f";
const summary: DocumentSummary = {
  id: parseDocumentId(documentId),
  displayName: "a.txt",
  mime: "text/plain",
  sizeBytes: 1,
  status: "ready",
  error: null,
  createdAt: new Date(0),
};

function setup(found: DocumentSummary | null) {
  const calls: unknown[] = [];
  const documents: DocumentRepository = {
    list: async (ws, limit) => {
      calls.push({ list: ws, limit });
      return [summary];
    },
    findById: async (ws, id) => {
      calls.push({ find: ws, id });
      return found;
    },
  };
  const uow: UnitOfWork<{ documents: DocumentRepository }> = {
    run: async (context, work) => {
      calls.push({ context });
      return work({ documents });
    },
  };
  return { deps: { uow }, calls };
}

describe("document reads", () => {
  it.each(roles)("lets a %s list, bounded by the quota, in the actor's workspace", async (role) => {
    const { deps, calls } = setup(null);
    expect(await listDocuments(deps, { userId, workspaceId, role })).toEqual([summary]);
    expect(calls).toEqual([
      { context: { userId, workspaceId } },
      { list: workspaceId, limit: maxListedDocuments },
    ]);
    expect(maxListedDocuments).toBe(50);
  });

  it.each(roles)("lets a %s read one document", async (role) => {
    const { deps } = setup(summary);
    expect(await getDocument(deps, { userId, workspaceId, role }, documentId)).toBe(summary);
  });

  it("answers an absent, deleted or foreign document and a malformed id the same way", async () => {
    const actor = { userId, workspaceId, role: "member" } as const;
    const { deps, calls } = setup(null);
    await expect(getDocument(deps, actor, documentId)).rejects.toThrow(DocumentNotFound);
    await expect(getDocument(deps, actor, "../x")).rejects.toThrow(DocumentNotFound);
    expect(calls.filter((c) => typeof c === "object" && c !== null && "find" in c)).toHaveLength(1);
  });
});
