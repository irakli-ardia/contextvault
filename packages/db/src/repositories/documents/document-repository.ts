import {
  type DocumentRepository,
  type DocumentSummary,
  isDocumentMime,
  isVersionStatus,
  parseDocumentId,
} from "@contextvault/domain";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../../client";
import { documents } from "../../schema/index";

// A document's status is its latest version's; it has no column of its own. The outer id is
// spelled out: Drizzle drops the table qualifier in a single-table select, and a bare "id" would
// bind to the version inside the subquery.
const latestStatus = sql<string | null>`(
  select v.status from "document_versions" v
  where v.document_id = "documents"."id" order by v.version_no desc limit 1)`;

const columns = {
  id: documents.id,
  displayName: documents.displayName,
  mime: documents.mime,
  sizeBytes: documents.sizeBytes,
  createdAt: documents.createdAt,
  status: latestStatus,
};

function toSummary(row: {
  id: string;
  displayName: string;
  mime: string;
  sizeBytes: number;
  createdAt: Date;
  status: string | null;
}): DocumentSummary {
  const { status, mime } = row;
  if (status === null || !isVersionStatus(status) || !isDocumentMime(mime)) {
    throw new Error("Unexpected document row in database");
  }
  return {
    id: parseDocumentId(row.id),
    displayName: row.displayName,
    mime,
    sizeBytes: row.sizeBytes,
    status,
    createdAt: row.createdAt,
  };
}

export function createDocumentRepository(executor: Executor): DocumentRepository {
  const live = (workspaceId: string) =>
    and(eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt));

  return {
    async list(workspaceId, limit) {
      const rows = await executor
        .select(columns)
        .from(documents)
        .where(live(workspaceId))
        .orderBy(desc(documents.createdAt), asc(documents.id)) // same order as the index
        .limit(limit);
      return rows.map(toSummary);
    },

    async findById(workspaceId, documentId) {
      const [row] = await executor
        .select(columns)
        .from(documents)
        .where(and(live(workspaceId), eq(documents.id, documentId)))
        .limit(1);
      return row === undefined ? null : toSummary(row);
    },
  };
}
