import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { documents } from "./documents";
import { appRole, inContextWorkspace } from "./rls";

// Tenant-owned and immutable for the application role (SELECT and INSERT only): the composite
// foreign key makes a version of another workspace's document impossible, and the key check ties
// the storage key to the three ids. Lifecycle columns start at their defaults; the ingestion
// state machine (M1.4) is what will be granted UPDATE on them.
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey(),
    documentId: uuid("document_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    versionNo: integer("version_no").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    status: text("status").notNull().default("uploaded"),
    leaseGeneration: integer("lease_generation").notNull().default(0),
    attempt: integer("attempt").notNull().default(0),
    errorStage: text("error_stage"),
    errorCode: text("error_code"),
    errorRetryable: boolean("error_retryable"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "document_versions_workspace_document_fk",
      columns: [table.workspaceId, table.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }).onDelete("cascade"),
    unique("document_versions_document_id_version_no_unique").on(table.documentId, table.versionNo),
    index("document_versions_workspace_document_idx").on(table.workspaceId, table.documentId),
    check("document_versions_version_no", sql`${table.versionNo} >= 1`),
    check(
      "document_versions_status",
      sql`${table.status} in ('uploaded', 'queued', 'parsing', 'chunking', 'ready', 'failed')`,
    ),
    check(
      "document_versions_counters",
      sql`${table.leaseGeneration} >= 0 and ${table.attempt} >= 0`,
    ),
    check(
      "document_versions_storage_key",
      sql`${table.storageKey} = 'ws/' || ${table.workspaceId}::text || '/doc/' || ${table.documentId}::text || '/v/' || ${table.id}::text`,
    ),
    pgPolicy("document_versions_select", {
      for: "select",
      to: appRole,
      using: inContextWorkspace(table.workspaceId),
    }),
    pgPolicy("document_versions_insert", {
      for: "insert",
      to: appRole,
      withCheck: inContextWorkspace(table.workspaceId),
    }),
  ],
).enableRLS();
