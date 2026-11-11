import {
  type DocumentFailure,
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

const latestErrorCode = sql<string | null>`(
  select v.error_code from "document_versions" v
  where v.document_id = "documents"."id" order by v.version_no desc limit 1)`;
const latestErrorRetryable = sql<boolean | null>`(
  select v.error_retryable from "document_versions" v
  where v.document_id = "documents"."id" order by v.version_no desc limit 1)`;

const columns = {
  id: documents.id,
  displayName: documents.displayName,
  mime: documents.mime,
  sizeBytes: documents.sizeBytes,
  createdAt: documents.createdAt,
  status: latestStatus,
  errorCode: latestErrorCode,
  errorRetryable: latestErrorRetryable,
};

export function toSummary(row: {
  id: string;
  displayName: string;
  mime: string;
  sizeBytes: number;
  createdAt: Date;
  status: string | null;
  errorCode: string | null;
  errorRetryable: boolean | null;
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
    error: status === "failed" ? toFailure(row.errorCode, row.errorRetryable) : null,
    createdAt: row.createdAt,
  };
}

// The code is written by the worker, a trusted but separate credential; anything that is not a
// plain dotted identifier is reported as `internal` so no free text can reach a client.
const stableCode = /^[a-z][a-z_]*(\.[a-z_]+)*$/;
function toFailure(code: string | null, retryable: boolean | null): DocumentFailure {
  const safe = code !== null && code.length <= 64 && stableCode.test(code);
  return { code: safe ? code : "internal", retryable: safe && retryable === true };
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
