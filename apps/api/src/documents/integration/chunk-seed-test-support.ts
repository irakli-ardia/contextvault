import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hashEmbed, hashEmbedder } from "@contextvault/ai";
import type { Account, createTenantFixture } from "../../testing/test-support";

type TenantFixture = Awaited<ReturnType<typeof createTenantFixture>>;

// Seeds what the worker's activation would produce, directly, so API tests need no worker.
export interface Seed {
  ws: string;
  by: Account;
  name: string;
  text: string;
  status?: string;
  deleted?: boolean;
  model?: string;
  /** Leave `active_version_id` unset: a version that was superseded or never activated. */
  inactive?: boolean;
}

export async function seedChunk(fx: TenantFixture, seed: Seed) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const sectionId = randomUUID();
  const chunkId = randomUUID();
  const q = (text: string, values: unknown[]) => fx.fixture.query(text, values);
  await q(
    `insert into documents (id, workspace_id, display_name, mime, size_bytes, content_sha256, created_by, deleted_at)
     values ($1, $2, $3, 'text/plain', 7, $4, $5, $6)`,
    [
      documentId,
      seed.ws,
      seed.name,
      randomBytes(32),
      seed.by.id,
      seed.deleted ? new Date().toISOString() : null,
    ],
  );
  await q(
    `insert into document_versions (id, document_id, workspace_id, version_no, storage_key, status)
     values ($1, $2, $3, 1, $4, $5)`,
    [
      versionId,
      documentId,
      seed.ws,
      `ws/${seed.ws}/doc/${documentId}/v/${versionId}`,
      seed.status ?? "ready",
    ],
  );
  await q(
    `insert into sections (id, workspace_id, version_id, ordinal, start_offset, end_offset)
     values ($1, $2, $3, 0, 0, $4)`,
    [sectionId, seed.ws, versionId, seed.text.length],
  );
  await q(
    `insert into chunks (id, workspace_id, version_id, section_id, strategy_id, strategy_version, ordinal, content, content_sha256, token_count, start_offset, end_offset)
     values ($1, $2, $3, $4, 'fixed-window', 1, 0, $5, $6, 1, 0, $7)`,
    [
      chunkId,
      seed.ws,
      versionId,
      sectionId,
      seed.text,
      createHash("sha256").update(seed.text).digest(),
      seed.text.length,
    ],
  );
  await q(
    `insert into chunk_embeddings (chunk_id, workspace_id, version_id, model, embedding)
     values ($1, $2, $3, $4, $5::vector)`,
    [
      chunkId,
      seed.ws,
      versionId,
      seed.model ?? hashEmbedder.model,
      `[${hashEmbed(seed.text).join(",")}]`,
    ],
  );
  if (!seed.inactive && !seed.deleted) {
    await q("update documents set active_version_id = $1 where id = $2", [versionId, documentId]);
  }
  return { documentId, chunkId };
}
