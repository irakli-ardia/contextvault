import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { documentVersions } from "./document-versions";
import {
  appRole,
  inContextWorkspace,
  inWorkerWorkspace,
  versionInChunking,
  versionOfPurgeableDocument,
  workerRole,
} from "./rls";
import { sections } from "./sections";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// Same posture as sections: written once by activation, insert-only for the worker, nothing for
// the application role yet. Identity is version + strategy + ordinal, so a replayed activation
// cannot add a second copy of a chunk. `content` is exactly the parsed text between the offsets.
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    versionId: uuid("version_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    strategyId: text("strategy_id").notNull(),
    strategyVersion: integer("strategy_version").notNull(),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    contentSha256: bytea("content_sha256").notNull(),
    tokenCount: integer("token_count").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
  },
  (table) => [
    foreignKey({
      name: "chunks_workspace_version_fk",
      columns: [table.workspaceId, table.versionId],
      foreignColumns: [documentVersions.workspaceId, documentVersions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "chunks_workspace_section_fk",
      columns: [table.workspaceId, table.versionId, table.sectionId],
      foreignColumns: [sections.workspaceId, sections.versionId, sections.id],
    }).onDelete("cascade"),
    unique("chunks_identity_unique").on(
      table.versionId,
      table.strategyId,
      table.strategyVersion,
      table.ordinal,
    ),
    // Target of the embedding foreign key: a vector's chunk must belong to the vector's own version.
    unique("chunks_id_workspace_version_unique").on(table.id, table.workspaceId, table.versionId),
    index("chunks_workspace_version_idx").on(table.workspaceId, table.versionId),
    index("chunks_section_idx").on(table.sectionId),
    check("chunks_ordinal", sql`${table.ordinal} >= 0`),
    check("chunks_strategy_version", sql`${table.strategyVersion} >= 1`),
    check("chunks_content_nonblank", sql`${table.content} ~ '\\S'`),
    check("chunks_content_sha256_length", sql`octet_length(${table.contentSha256}) = 32`),
    check("chunks_token_count", sql`${table.tokenCount} >= 1`),
    check(
      "chunks_offsets",
      sql`${table.startOffset} >= 0 and ${table.endOffset} > ${table.startOffset}`,
    ),
    pgPolicy("chunks_worker_insert", {
      for: "insert",
      to: workerRole,
      withCheck: sql`${inWorkerWorkspace(table.workspaceId)} and ${versionInChunking(table.workspaceId, table.versionId)}`,
    }),
    // Ids only (column grant, migration 0016): the version policy asks whether chunks exist.
    pgPolicy("chunks_worker_select", {
      for: "select",
      to: workerRole,
      using: inWorkerWorkspace(table.workspaceId),
    }),
    // Retrieval (M2, migration 0021): the application role reads the evidence columns of its own
    // workspace (column grant: no hashes, no strategy details).
    pgPolicy("chunks_app_select", {
      for: "select",
      to: appRole,
      using: inContextWorkspace(table.workspaceId),
    }),
    // Purge (migration 0018): only the rows of a deleted, unpurged document.
    pgPolicy("chunks_worker_purge", {
      for: "delete",
      to: workerRole,
      using: sql`${inWorkerWorkspace(table.workspaceId)} and ${versionOfPurgeableDocument(table.workspaceId, table.versionId)}`,
    }),
  ],
).enableRLS();
