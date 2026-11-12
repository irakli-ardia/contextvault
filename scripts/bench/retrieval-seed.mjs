// Seeds one benchmark workspace through the fixture role (RLS-exempt, like the integration tests'
// seeding) and removes it again. Nothing outside the workspace and user created here is touched.

import { randomUUID } from "node:crypto";
import { chunkRow, chunkVector, DOCUMENTS, idOf, MODEL } from "./retrieval-corpus.mjs";

const BATCH = 400;
export async function createOwner(fixture) {
  const userId = randomUUID();
  await fixture.query("insert into users (id, email) values ($1, $2)", [
    userId,
    `${userId}@bench.invalid`,
  ]);
  return userId;
}

/** A workspace of `total` chunks over DOCUMENTS live documents, each with one ready, active version. */
export async function seedWorkspace(fixture, userId, total) {
  const workspaceId = randomUUID();
  await fixture.query(
    "insert into workspaces (id, name, created_by) values ($1, 'retrieval-bench', $2)",
    [workspaceId, userId],
  );
  await fixture.query(
    "insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')",
    [workspaceId, userId],
  );
  const perDocument = Math.ceil(total / DOCUMENTS);
  const documents = Math.ceil(total / perDocument);
  // Ids are deterministic per (workspace, index); the workspace salt keeps sizes from colliding.
  const ids = Object.fromEntries(
    ["document", "version", "section", "chunk"].map((kind) => [
      kind,
      (n) => idOf(`${kind}:${workspaceId}`, n),
    ]),
  );
  for (let d = 0; d < documents; d += 1) {
    const doc = ids.document(d);
    await fixture.query(
      `insert into documents (id, workspace_id, display_name, mime, size_bytes, content_sha256, created_by)
       values ($1, $2, $3, 'text/plain', 1, sha256(convert_to($3, 'UTF8')), $4)`,
      [doc, workspaceId, `bench-${d}.txt`, userId],
    );
    await fixture.query(
      `insert into document_versions (id, document_id, workspace_id, version_no, storage_key, status)
       values ($1, $2, $3, 1, $4, 'ready')`,
      [ids.version(d), doc, workspaceId, `ws/${workspaceId}/doc/${doc}/v/${ids.version(d)}`],
    );
    await fixture.query(
      `insert into sections (id, workspace_id, version_id, ordinal, start_offset, end_offset)
       values ($1, $2, $3, 0, 0, $4)`,
      [ids.section(d), workspaceId, ids.version(d), perDocument * 1800 + 2000],
    );
    await fixture.query("update documents set active_version_id = $1 where id = $2", [
      ids.version(d),
      doc,
    ]);
  }
  for (let from = 0; from < total; from += BATCH) {
    const rows = [];
    for (let i = from; i < Math.min(total, from + BATCH); i += 1) {
      rows.push({ ...chunkRow(i, total, ids), index: i });
    }
    const column = (pick) => rows.map(pick);
    await fixture.query(
      `insert into chunks (id, workspace_id, version_id, section_id, strategy_id, strategy_version,
         ordinal, content, content_sha256, token_count, start_offset, end_offset)
       select t.id, $1::uuid, t.version_id, t.section_id, 'fixed-window', 1, t.ordinal, t.content,
         sha256(convert_to(t.content, 'UTF8')), 475, t.start_offset, t.end_offset
       from unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::int[], $6::text[], $7::int[], $8::int[])
         as t(id, version_id, section_id, ordinal, content, start_offset, end_offset)`,
      [
        workspaceId,
        column((r) => r.id),
        column((r) => r.versionId),
        column((r) => r.sectionId),
        column((r) => r.ordinal),
        column((r) => r.content),
        column((r) => r.startOffset),
        column((r) => r.endOffset),
      ],
    );
    await fixture.query(
      `insert into chunk_embeddings (chunk_id, workspace_id, version_id, model, embedding)
       select t.id, $1::uuid, t.version_id, $4, t.v::vector
       from unnest($2::uuid[], $3::uuid[], $5::text[]) as t(id, version_id, v)`,
      [
        workspaceId,
        column((r) => r.id),
        column((r) => r.versionId),
        MODEL,
        column((r) => chunkVector(r.index)),
      ],
    );
  }
  await fixture.query("vacuum (analyze) chunks");
  await fixture.query("vacuum (analyze) chunk_embeddings");
  await fixture.query("analyze documents");
  await fixture.query("analyze document_versions");
  return workspaceId;
}

export async function removeWorkspace(fixture, workspaceId) {
  await fixture.query("delete from workspaces where id = $1", [workspaceId]);
}

/** Also drops any workspace a failed seeding left behind (documents cascade from workspaces). */
export async function removeOwner(fixture, userId) {
  await fixture.query("delete from workspaces where created_by = $1", [userId]);
  await fixture.query("delete from memberships where user_id = $1", [userId]);
  await fixture.query("delete from users where id = $1", [userId]);
}
