import {
  type OutboxSource,
  parseDocumentVersionId,
  parseOutboxId,
  parseWorkspaceId,
} from "@contextvault/domain";
import { and, asc, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../../client";
import { outbox } from "../../schema/index";

// Cross-workspace discovery, outside any transaction and with no workspace context: the worker's
// SELECT policy on the outbox is `using (true)` over ids, a kind and times only (migration 0008).
export function createOutboxSource(db: Database): OutboxSource {
  return {
    async listDue(limit) {
      const rows = await db
        .select({
          id: outbox.id,
          workspaceId: outbox.workspaceId,
          versionId: outbox.versionId,
          availableAt: outbox.availableAt,
        })
        .from(outbox)
        .where(and(isNull(outbox.dispatchedAt), lte(outbox.availableAt, sql`now()`)))
        .orderBy(asc(outbox.availableAt), asc(outbox.id))
        .limit(limit);
      return rows.map((row) => ({
        id: parseOutboxId(row.id),
        workspaceId: parseWorkspaceId(row.workspaceId),
        versionId: parseDocumentVersionId(row.versionId),
        availableAt: row.availableAt,
      }));
    },
  };
}
