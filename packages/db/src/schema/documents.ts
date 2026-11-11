import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appRole, currentUserId, inContextWorkspace, inWorkerWorkspace, workerRole } from "./rls";
import { users } from "./users";
import { workspaces } from "./workspaces";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// Tenant-owned, append-only for the application role (SELECT and INSERT only, migration 0006). A
// row exists only after its object was stored and verified: in-flight uploads live in
// pending_uploads. `deleted_at` is null until the delete path (M1.7); the dedupe index ignores
// deleted rows. The (workspace_id, id) key lets document_versions point at a document of the
// same workspace only.
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentSha256: bytea("content_sha256").notNull(),
    // The version retrieval reads, set only by the worker's activation (column grant, 0015). Its
    // foreign key to document_versions(document_id, id) is raw SQL in migration 0015: stating it
    // here would make this file and document-versions.ts import each other.
    activeVersionId: uuid("active_version_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("documents_workspace_id_id_unique").on(table.workspaceId, table.id),
    uniqueIndex("documents_workspace_content_live_idx")
      .on(table.workspaceId, table.contentSha256)
      .where(sql`${table.deletedAt} is null`),
    index("documents_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt.desc(),
      table.id,
    ),
    check(
      "documents_display_name_length",
      sql`octet_length(${table.displayName}) between 1 and 255`,
    ),
    check(
      "documents_mime",
      sql`${table.mime} in ('application/pdf', 'text/markdown', 'text/plain')`,
    ),
    check("documents_size_bytes", sql`${table.sizeBytes} between 1 and 10485760`),
    check("documents_content_sha256_length", sql`octet_length(${table.contentSha256}) = 32`),
    pgPolicy("documents_select", {
      for: "select",
      to: appRole,
      using: inContextWorkspace(table.workspaceId),
    }),
    pgPolicy("documents_insert", {
      for: "insert",
      to: appRole,
      withCheck: sql`${inContextWorkspace(table.workspaceId)} and ${table.createdBy} = ${currentUserId}`,
    }),
    // Read-only recheck of `deleted_at` inside the job's workspace (column grant, migration 0008).
    pgPolicy("documents_worker_select", {
      for: "select",
      to: workerRole,
      using: inWorkerWorkspace(table.workspaceId),
    }),
    // Activation sets `active_version_id` and nothing else (column grant, migration 0015).
    pgPolicy("documents_worker_activate", {
      for: "update",
      to: workerRole,
      using: inWorkerWorkspace(table.workspaceId),
      // The new pointer must name a ready version of this same, live document, and no other ready
      // version of it may be newer: an older version finishing late cannot replace a newer one.
      withCheck: sql`${inWorkerWorkspace(table.workspaceId)} and ${table.deletedAt} is null and exists (
        select 1 from "document_versions" v
        where v.id = ${table.activeVersionId} and v.document_id = ${table.id}
          and v.workspace_id = ${table.workspaceId} and v.status = 'ready'
          and not exists (select 1 from "document_versions" n
            where n.document_id = v.document_id and n.workspace_id = v.workspace_id
              and n.status = 'ready' and n.version_no > v.version_no))`,
    }),
  ],
).enableRLS();
