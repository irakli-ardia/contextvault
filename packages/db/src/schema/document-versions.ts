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
import { appRole, inContextWorkspace, inWorkerWorkspace, workerRole } from "./rls";

// Tenant-owned and immutable for the application role (SELECT and INSERT only): the composite
// foreign key makes a version of another workspace's document impossible, and the key check ties
// the storage key to the three ids. Lifecycle columns start at their defaults; the worker role
// alone may update them (migration 0008), and may read only non-sensitive columns across
// workspaces. `ready` is written only by the worker's activation transaction, together with the
// version's sections and chunks and the document's `active_version_id`. `processed` is retired
// (M1.5 end state) and stays valid for rows written before M1.6.
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
    unique("document_versions_workspace_id_id_unique").on(table.workspaceId, table.id),
    // Target of documents.active_version_id: the active version must belong to that document.
    unique("document_versions_document_id_id_unique").on(table.documentId, table.id),
    index("document_versions_workspace_document_idx").on(table.workspaceId, table.documentId),
    // Recovery discovery (M1.4 5B): oldest lease first, over the few rows in a running state, so
    // the sweep never scans the settled majority.
    index("document_versions_running_updated_idx")
      .on(table.updatedAt)
      .where(sql`${table.status} in ('parsing', 'chunking')`),
    // Orphan discovery: waiting versions in `(updated_at, id)` keyset order.
    index("document_versions_waiting_updated_idx")
      .on(table.updatedAt, table.id)
      .where(sql`${table.status} in ('uploaded', 'queued')`),
    check("document_versions_version_no", sql`${table.versionNo} >= 1`),
    check(
      "document_versions_status",
      sql`${table.status} in ('uploaded', 'queued', 'parsing', 'chunking', 'processed', 'ready', 'failed')`,
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
    // The delete command closes the non-terminal versions of a document that is already deleted
    // (documents are locked and updated first). The only admitted result is the closed state; the
    // column grant (migration 0017) limits which columns can change.
    pgPolicy("document_versions_app_close", {
      for: "update",
      to: appRole,
      using: sql`${inContextWorkspace(table.workspaceId)}
        and ${table.status} in ('uploaded', 'queued', 'parsing', 'chunking')
        and exists (select 1 from "documents" d
          where d.id = ${table.documentId} and d.workspace_id = ${table.workspaceId}
            and d.deleted_at is not null)`,
      // The deleted-document clause matters because permissive UPDATE policies are OR-ed per clause:
      // without it, a row admitted by the retry policy's USING could be rewritten into the closed
      // state of a document that is still live (migration 0019).
      withCheck: sql`${inContextWorkspace(table.workspaceId)} and ${table.status} = 'failed'
        and ${table.errorCode} = 'document.deleted' and ${table.errorRetryable} = false
        and ${table.errorStage} is null
        and exists (select 1 from "documents" d
          where d.id = ${table.documentId} and d.workspace_id = ${table.workspaceId}
            and d.deleted_at is not null)`,
    }),
    // The retry command (M1.8b, migrations 0019 and 0020): a version of a live document, failed
    // with a retryable error, becomes queued with a fresh attempt budget and no recorded failure.
    // The new row must belong to a live document, so this policy can never revive a closed version
    // of a deleted one (the close policy's USING is OR-ed with this WITH CHECK). The old row is
    // invisible to a WITH CHECK, so `lease_generation` is bumped by the command, not by the policy.
    // Not expressed here: "latest version only". A policy of this table that reads this table is
    // rejected by PostgreSQL (42P17, infinite recursion; 0019 shipped it and 0020 removed it), so
    // the command's own WHERE enforces it. Today a document has exactly one version.
    pgPolicy("document_versions_app_retry", {
      for: "update",
      to: appRole,
      using: sql`${inContextWorkspace(table.workspaceId)}
        and ${table.status} = 'failed' and ${table.errorRetryable} = true
        and exists (select 1 from "documents" d
          where d.id = ${table.documentId} and d.workspace_id = ${table.workspaceId}
            and d.deleted_at is null)`,
      withCheck: sql`${inContextWorkspace(table.workspaceId)}
        and ${table.status} = 'queued' and ${table.attempt} = 0
        and ${table.errorStage} is null and ${table.errorCode} is null
        and ${table.errorRetryable} is null
        and exists (select 1 from "documents" d
          where d.id = ${table.documentId} and d.workspace_id = ${table.workspaceId}
            and d.deleted_at is null)`,
    }),
    // Discovery: every workspace's lifecycle metadata, nothing else (column grant, migration 0008).
    pgPolicy("document_versions_worker_discover", {
      for: "select",
      to: workerRole,
      using: sql`true`,
    }),
    pgPolicy("document_versions_worker_update", {
      for: "update",
      to: workerRole,
      using: inWorkerWorkspace(table.workspaceId),
      // `ready` only for a version that already has chunks (written while it was `chunking`).
      withCheck: sql`${inWorkerWorkspace(table.workspaceId)} and (${table.status} <> 'ready' or exists (
        select 1 from "chunks" c where c.version_id = ${table.id} and c.workspace_id = ${table.workspaceId}))`,
    }),
  ],
).enableRLS();
