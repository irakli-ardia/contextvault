import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { appRole, currentUserId, inContextWorkspace } from "./rls";
import { users } from "./users";
import { workspaces } from "./workspaces";

// The intent log of an upload: written before any byte is stored, removed in the transaction that
// creates the document. `id` is the future version id. A row that outlives its upload marks an
// object that may exist, so rows count toward quota whatever their age and are only removed by
// their creator (or, later, the maintenance sweeper). Visible to every member of the workspace,
// because quota is the workspace's.
export const pendingUploads = pgTable(
  "pending_uploads",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull().unique(),
    declaredBytes: integer("declared_bytes").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pending_uploads_workspace_created_idx").on(table.workspaceId, table.createdAt),
    check("pending_uploads_declared_bytes", sql`${table.declaredBytes} between 1 and 10485760`),
    check(
      "pending_uploads_storage_key",
      sql`${table.storageKey} ~ ('^ws/' || ${table.workspaceId}::text || '/doc/[0-9a-f-]{36}/v/' || ${table.id}::text || '$')`,
    ),
    pgPolicy("pending_uploads_select", {
      for: "select",
      to: appRole,
      using: inContextWorkspace(table.workspaceId),
    }),
    pgPolicy("pending_uploads_insert", {
      for: "insert",
      to: appRole,
      withCheck: sql`${inContextWorkspace(table.workspaceId)} and ${table.createdBy} = ${currentUserId}`,
    }),
    pgPolicy("pending_uploads_delete_own", {
      for: "delete",
      to: appRole,
      using: sql`${inContextWorkspace(table.workspaceId)} and ${table.createdBy} = ${currentUserId}`,
    }),
  ],
).enableRLS();
