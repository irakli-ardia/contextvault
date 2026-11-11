import {
  type ParseSourceRepository,
  parseDocumentId,
  type WorkspaceId,
} from "@contextvault/domain";
import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../../client";
import { documents, documentVersions } from "../../schema/index";

// Reads only what the worker role is granted (ids and `deleted_at`); the object key is derived from
// them, and the version's CHECK constraint guarantees it equals the stored key. Both rows are
// matched on the job's workspace, so a version id from another tenant finds nothing.
export function createParseSourceRepository(
  executor: Executor,
  workspaceId: WorkspaceId,
): ParseSourceRepository {
  return {
    async findParseSource(versionId) {
      const [row] = await executor
        .select({ documentId: documentVersions.documentId })
        .from(documentVersions)
        .innerJoin(
          documents,
          and(
            eq(documents.id, documentVersions.documentId),
            eq(documents.workspaceId, documentVersions.workspaceId),
          ),
        )
        .where(
          and(
            eq(documentVersions.id, versionId),
            eq(documentVersions.workspaceId, workspaceId),
            isNull(documents.deletedAt),
          ),
        );
      return row ? { documentId: parseDocumentId(row.documentId) } : null;
    },
  };
}
