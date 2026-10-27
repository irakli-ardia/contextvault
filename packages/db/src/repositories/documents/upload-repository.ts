import {
  parseDocumentId,
  parseDocumentVersionId,
  parseStorageKey,
  UploadConflict,
  type UploadRepository,
  UploadReservationMissing,
  WorkspaceAccessDenied,
} from "@contextvault/domain";
import { and, asc, eq, isNull, lt } from "drizzle-orm";
import type { Executor } from "../../client";
import { documents, documentVersions, pendingUploads } from "../../schema/index";
import { postgresErrorCode } from "../workspaces/postgres-error";
import { createDocumentRepository } from "./document-repository";
import { lockWorkspaceQuota, quotaRefusal } from "./quota";

const uniqueViolation = "23505";
const insufficientPrivilege = "42501";

function translate(error: unknown): unknown {
  switch (postgresErrorCode(error)) {
    case uniqueViolation:
      return new UploadConflict({ cause: error });
    case insufficientPrivilege:
      return new WorkspaceAccessDenied({ cause: error });
    default:
      return error;
  }
}

export function createUploadRepository(executor: Executor): UploadRepository {
  const documentsRepo = createDocumentRepository(executor);

  return {
    async reserveUpload(input, quota) {
      await lockWorkspaceQuota(executor, input.workspaceId);
      const reason = await quotaRefusal(
        executor,
        input.workspaceId,
        input.versionId,
        input.declaredBytes,
        quota,
      );
      if (reason !== null) return { outcome: "quota", reason };
      await executor
        .insert(pendingUploads)
        .values({
          id: input.versionId,
          workspaceId: input.workspaceId,
          storageKey: input.storageKey,
          declaredBytes: input.declaredBytes,
          createdBy: input.createdBy,
        })
        .catch((error: unknown) => {
          throw translate(error);
        });
      return { outcome: "reserved" };
    },

    async finalizeUpload(input, quota) {
      await lockWorkspaceQuota(executor, input.workspaceId);

      // Same bytes already in the workspace: no new document, no quota.
      const [twin] = await executor
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.workspaceId, input.workspaceId),
            eq(documents.contentSha256, Buffer.from(input.contentSha256)),
            isNull(documents.deletedAt),
          ),
        )
        .limit(1);
      if (twin !== undefined) {
        const document = await documentsRepo.findById(input.workspaceId, parseDocumentId(twin.id));
        if (document === null)
          throw new Error("Duplicate document vanished inside its transaction");
        return { outcome: "duplicate", document };
      }

      const reason = await quotaRefusal(
        executor,
        input.workspaceId,
        input.versionId,
        input.sizeBytes,
        quota,
      );
      if (reason !== null) return { outcome: "quota", reason };

      try {
        const [created] = await executor
          .insert(documents)
          .values({
            id: input.documentId,
            workspaceId: input.workspaceId,
            displayName: input.displayName,
            mime: input.mime,
            sizeBytes: input.sizeBytes,
            contentSha256: Buffer.from(input.contentSha256),
            createdBy: input.createdBy,
          })
          .returning({ createdAt: documents.createdAt });
        if (created === undefined) throw new Error("Document insert returned no row");
        await executor.insert(documentVersions).values({
          id: input.versionId,
          documentId: input.documentId,
          workspaceId: input.workspaceId,
          versionNo: 1,
          storageKey: input.storageKey,
        });
        // The reservation must still be there: a swept or foreign one never yields a document.
        const removed = await executor
          .delete(pendingUploads)
          .where(
            and(
              eq(pendingUploads.id, input.versionId),
              eq(pendingUploads.workspaceId, input.workspaceId),
              eq(pendingUploads.storageKey, input.storageKey),
            ),
          )
          .returning({ id: pendingUploads.id });
        if (removed.length !== 1) throw new UploadReservationMissing();
        return {
          outcome: "created",
          document: {
            id: input.documentId,
            displayName: input.displayName,
            mime: input.mime,
            sizeBytes: input.sizeBytes,
            status: "uploaded",
            createdAt: created.createdAt,
          },
        };
      } catch (error) {
        throw translate(error);
      }
    },

    async releaseUpload(workspaceId, versionId) {
      const removed = await executor
        .delete(pendingUploads)
        .where(and(eq(pendingUploads.id, versionId), eq(pendingUploads.workspaceId, workspaceId)))
        .returning({ id: pendingUploads.id });
      return removed.length === 1;
    },

    async listPendingUploads(workspaceId, createdBefore, limit) {
      const rows = await executor
        .select()
        .from(pendingUploads)
        .where(
          and(
            eq(pendingUploads.workspaceId, workspaceId),
            lt(pendingUploads.createdAt, createdBefore),
          ),
        )
        .orderBy(asc(pendingUploads.createdAt), asc(pendingUploads.id))
        .limit(limit);
      return rows.map((row) => ({
        versionId: parseDocumentVersionId(row.id),
        storageKey: parseStorageKey(row.storageKey),
        declaredBytes: row.declaredBytes,
        createdAt: row.createdAt,
      }));
    },
  };
}
