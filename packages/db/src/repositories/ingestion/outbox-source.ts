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
//
// The cursor is the keyset `(available_at, id)` as text. The time travels as PostgreSQL's own
// microsecond text: a JavaScript Date keeps milliseconds, so a Date cursor would sit before the
// row it came from and return it again. The id breaks ties, and the pair is unique.
const separator = "|";

export function createOutboxSource(db: Database): OutboxSource {
  return {
    async listDue(limit, after) {
      const [at = "", id = ""] = after === undefined ? [] : after.split(separator);
      const rows = await db
        .select({
          id: outbox.id,
          workspaceId: outbox.workspaceId,
          versionId: outbox.versionId,
          availableAt: outbox.availableAt,
          at: sql<string>`${outbox.availableAt}::text`,
        })
        .from(outbox)
        .where(
          and(
            isNull(outbox.dispatchedAt),
            lte(outbox.availableAt, sql`now()`),
            after === undefined
              ? undefined
              : sql`(${outbox.availableAt}, ${outbox.id}) > (${at}::timestamptz, ${id}::uuid)`,
          ),
        )
        .orderBy(asc(outbox.availableAt), asc(outbox.id))
        .limit(limit);
      return rows.map((row) => ({
        id: parseOutboxId(row.id),
        workspaceId: parseWorkspaceId(row.workspaceId),
        versionId: parseDocumentVersionId(row.versionId),
        availableAt: row.availableAt,
        cursor: `${row.at}${separator}${row.id}`,
      }));
    },
  };
}
