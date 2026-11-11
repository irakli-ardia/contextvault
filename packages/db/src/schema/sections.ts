import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { documentVersions } from "./document-versions";
import { inWorkerWorkspace, versionInChunking, workerRole } from "./rls";

// Derived data of one version, written once by the worker's activation transaction and never
// updated. The worker may only INSERT, bound to the workspace its job asserted (migration 0015);
// the application role has no access until retrieval (M2) is reviewed. A section is a PDF page,
// or all of a text; chunks never cross one.
export const sections = pgTable(
  "sections",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    versionId: uuid("version_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    page: integer("page"),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
  },
  (table) => [
    foreignKey({
      name: "sections_workspace_version_fk",
      columns: [table.workspaceId, table.versionId],
      foreignColumns: [documentVersions.workspaceId, documentVersions.id],
    }).onDelete("cascade"),
    unique("sections_workspace_id_id_unique").on(table.workspaceId, table.id),
    // Target of the chunk foreign key: a chunk's section must belong to the chunk's own version.
    unique("sections_workspace_version_id_unique").on(table.workspaceId, table.versionId, table.id),
    unique("sections_version_id_ordinal_unique").on(table.versionId, table.ordinal),
    index("sections_workspace_version_idx").on(table.workspaceId, table.versionId),
    check("sections_ordinal", sql`${table.ordinal} >= 0`),
    check("sections_page", sql`${table.page} is null or ${table.page} >= 1`),
    check(
      "sections_offsets",
      sql`${table.startOffset} >= 0 and ${table.endOffset} >= ${table.startOffset}`,
    ),
    pgPolicy("sections_worker_insert", {
      for: "insert",
      to: workerRole,
      withCheck: sql`${inWorkerWorkspace(table.workspaceId)} and ${versionInChunking(table.workspaceId, table.versionId)}`,
    }),
  ],
).enableRLS();
