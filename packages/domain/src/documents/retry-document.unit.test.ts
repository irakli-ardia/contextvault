import { describe, expect, it } from "vitest";
import { parseDocumentId, parseUserId, parseWorkspaceId } from "../kernel/ids";
import type { UnitOfWork } from "../kernel/unit-of-work";
import type { Role } from "../workspaces/workspace";
import type { DocumentSummary } from "./document";
import { DocumentNotFound, DocumentNotRetryable } from "./errors";
import { type RetryDocumentDeps, retryDocument } from "./retry-document";
import type { DocumentRepository, DocumentRetryRepository } from "./upload-ports";

const workspaceId = parseWorkspaceId("0b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f");
const userId = parseUserId("1b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f");
const rawDocumentId = "3b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f";
const documentId = parseDocumentId(rawDocumentId);
const outboxId = "4b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f";
const actor = (role: Role) => ({ userId, workspaceId, role });
const summary: DocumentSummary = {
  id: documentId,
  displayName: "a.txt",
  mime: "text/plain",
  sizeBytes: 1,
  status: "queued",
  error: null,
  createdAt: new Date(0),
};

function setup(
  outcome: Awaited<ReturnType<DocumentRetryRepository["retry"]>>,
  found: DocumentSummary | null = summary,
) {
  const calls: unknown[] = [];
  const uow: UnitOfWork<{ documentRetry: DocumentRetryRepository; documents: DocumentRepository }> =
    {
      run: async (context, work, options) => {
        calls.push({ context, options });
        return work({
          documentRetry: {
            retry: async (ws, id, outbox) => {
              calls.push({ ws, id, outbox });
              return outcome;
            },
          },
          documents: {
            list: async () => [],
            findById: async () => found,
          },
        });
      },
    };
  const deps: RetryDocumentDeps = { uow, newId: () => outboxId };
  return { deps, calls };
}

describe("retryDocument", () => {
  it.each(["owner", "admin", "member"] as const)(
    "lets a workspace %s retry in their own workspace and returns the document",
    async (role) => {
      const { deps, calls } = setup("retried");
      expect(await retryDocument(deps, { actor: actor(role), documentId: rawDocumentId })).toEqual(
        summary,
      );
      expect(calls).toEqual([
        { context: { userId, workspaceId }, options: { timeoutMs: 10_000 } },
        { ws: workspaceId, id: documentId, outbox: outboxId },
      ]);
    },
  );

  it("answers a missing, deleted or foreign document as not found", async () => {
    const { deps } = setup("not_found");
    await expect(
      retryDocument(deps, { actor: actor("owner"), documentId: rawDocumentId }),
    ).rejects.toThrow(DocumentNotFound);
  });

  it("answers a malformed id as not found before any transaction opens", async () => {
    const { deps, calls } = setup("retried");
    await expect(
      retryDocument(deps, { actor: actor("owner"), documentId: "not-a-uuid" }),
    ).rejects.toThrow(DocumentNotFound);
    expect(calls).toEqual([]);
  });

  it("refuses a version that is not a retryable failure", async () => {
    const { deps } = setup("not_retryable");
    await expect(
      retryDocument(deps, { actor: actor("member"), documentId: rawDocumentId }),
    ).rejects.toThrow(DocumentNotRetryable);
  });

  it("reports not found when the document vanishes between the two steps", async () => {
    const { deps } = setup("retried", null);
    await expect(
      retryDocument(deps, { actor: actor("owner"), documentId: rawDocumentId }),
    ).rejects.toThrow(DocumentNotFound);
  });

  it("rejects an invalid generated outbox id before any transaction opens", async () => {
    const { deps, calls } = setup("retried");
    await expect(
      retryDocument(
        { ...deps, newId: () => "nope" },
        { actor: actor("owner"), documentId: rawDocumentId },
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
