import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "../kernel/ids";
import type { UnitOfWork } from "../kernel/unit-of-work";
import { PermissionDenied } from "../workspaces/permissions";
import type { Role } from "../workspaces/workspace";
import { type DeleteDocumentDeps, deleteDocument } from "./delete-document";
import { DocumentNotFound } from "./errors";
import type { DocumentDeletionRepository } from "./upload-ports";

const workspaceId = parseWorkspaceId("0b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f");
const userId = parseUserId("1b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f");
const documentId = "3b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f";
const actor = (role: Role) => ({ userId, workspaceId, role });

function setup(result: Awaited<ReturnType<DocumentDeletionRepository["softDelete"]>>) {
  const calls: unknown[] = [];
  const uow: UnitOfWork<{ documentDeletion: DocumentDeletionRepository }> = {
    run: async (context, work, options) => {
      calls.push({ context, options });
      return work({
        documentDeletion: {
          softDelete: async (ws, id) => {
            calls.push({ ws, id });
            return result;
          },
        },
      });
    },
  };
  const deps: DeleteDocumentDeps = { uow };
  return { deps, calls };
}

describe("deleteDocument", () => {
  it.each(["owner", "admin"] as const)(
    "lets a workspace %s delete in their own workspace",
    async (role) => {
      const { deps, calls } = setup("deleted");
      expect(await deleteDocument(deps, { actor: actor(role), documentId })).toBe("deleted");
      expect(calls).toEqual([
        { context: { userId, workspaceId }, options: { timeoutMs: 10_000 } },
        { ws: workspaceId, id: documentId },
      ]);
    },
  );

  it("refuses a member before any transaction opens", async () => {
    const { deps, calls } = setup("deleted");
    await expect(deleteDocument(deps, { actor: actor("member"), documentId })).rejects.toThrow(
      PermissionDenied,
    );
    expect(calls).toEqual([]);
  });

  it("reports a repeated delete as already deleted", async () => {
    const { deps } = setup("already_deleted");
    expect(await deleteDocument(deps, { actor: actor("owner"), documentId })).toBe(
      "already_deleted",
    );
  });

  it.each([
    ["an absent or foreign document", documentId],
    ["a malformed id", "not-a-uuid"],
  ])("answers %s as not found", async (_name, id) => {
    const { deps } = setup("not_found");
    await expect(deleteDocument(deps, { actor: actor("owner"), documentId: id })).rejects.toThrow(
      DocumentNotFound,
    );
  });
});
