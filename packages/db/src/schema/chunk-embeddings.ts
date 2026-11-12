import { sql } from "drizzle-orm";
import { foreignKey, index, pgPolicy, pgTable, text, uuid, vector } from "drizzle-orm/pg-core";
import { chunks } from "./chunks";
import {
  appRole,
  inContextWorkspace,
  inWorkerWorkspace,
  versionInChunking,
  workerRole,
} from "./rls";

// One vector per chunk, written with its chunk by the worker's activation transaction (so a ready
// version is always fully embedded) and removed with it by the purge (cascade). `model` names the
// embedder; a query only meets vectors of its own model. 1536 = domain `embeddingDimensions`.
// No vector index: search is an exact scan of one workspace's rows (btree on workspace + model),
// which is correct at portfolio scale; HNSW would need filtered-search care (ADR when needed).
export const chunkEmbeddings = pgTable(
  "chunk_embeddings",
  {
    chunkId: uuid("chunk_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    versionId: uuid("version_id").notNull(),
    model: text("model").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  },
  (table) => [
    foreignKey({
      name: "chunk_embeddings_chunk_fk",
      columns: [table.chunkId, table.workspaceId, table.versionId],
      foreignColumns: [chunks.id, chunks.workspaceId, chunks.versionId],
    }).onDelete("cascade"),
    index("chunk_embeddings_workspace_model_idx").on(table.workspaceId, table.model),
    pgPolicy("chunk_embeddings_worker_insert", {
      for: "insert",
      to: workerRole,
      withCheck: sql`${inWorkerWorkspace(table.workspaceId)} and ${versionInChunking(table.workspaceId, table.versionId)}`,
    }),
    pgPolicy("chunk_embeddings_app_select", {
      for: "select",
      to: appRole,
      using: inContextWorkspace(table.workspaceId),
    }),
  ],
).enableRLS();
