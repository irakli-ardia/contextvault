import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { documentVersions } from "./document-versions";
import { inWorkerWorkspace, workerRole } from "./rls";

// Transactional outbox: ids only, no document data. The upload transaction inserts the first row
// (a later increment grants that to the application role); the worker dispatches rows to BullMQ
// and marks them. `available_at` carries retry backoff, so PostgreSQL owns the schedule. At most
// one undispatched row per version keeps recovery idempotent. The worker may read every workspace's
// rows to find work (ids are not sensitive) but insert and mark only inside the workspace its
// unit of work asserted.
export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    versionId: uuid("version_id").notNull(),
    kind: text("kind").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "outbox_workspace_version_fk",
      columns: [table.workspaceId, table.versionId],
      foreignColumns: [documentVersions.workspaceId, documentVersions.id],
    }).onDelete("cascade"),
    uniqueIndex("outbox_workspace_version_live_idx")
      .on(table.workspaceId, table.versionId)
      .where(sql`${table.dispatchedAt} is null`),
    index("outbox_pending_available_idx")
      .on(table.availableAt)
      .where(sql`${table.dispatchedAt} is null`),
    check("outbox_kind", sql`${table.kind} in ('process_version')`),
    pgPolicy("outbox_worker_discover", { for: "select", to: workerRole, using: sql`true` }),
    pgPolicy("outbox_worker_insert", {
      for: "insert",
      to: workerRole,
      withCheck: inWorkerWorkspace(table.workspaceId),
    }),
    pgPolicy("outbox_worker_mark", {
      for: "update",
      to: workerRole,
      using: inWorkerWorkspace(table.workspaceId),
      withCheck: inWorkerWorkspace(table.workspaceId),
    }),
  ],
).enableRLS();
