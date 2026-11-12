import type { SearchRepository } from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Executor } from "../../client";

interface Row extends Record<string, unknown> {
  chunk_id: string;
  document_id: string;
  display_name: string;
  content: string;
  start_offset: number;
  end_offset: number;
  score: number;
}

// Shared by every retrieval signal so they cannot drift apart. Authorization is part of the
// statement, not applied to its result: the workspace (also enforced by RLS), a live document, and
// the document's *active* ready version, so superseded, failed, unfinished and deleted versions
// have no rows to return.
const authorizedChunks = sql`
  from chunks c
  join document_versions v on v.id = c.version_id and v.workspace_id = c.workspace_id
  join documents d on d.id = v.document_id and d.workspace_id = v.workspace_id
    and d.active_version_id = v.id`;
const authorizedWhere = (workspaceId: string) =>
  sql`c.workspace_id = ${workspaceId} and d.deleted_at is null and v.status = 'ready'`;

const columns = sql`c.id as chunk_id, d.id as document_id, d.display_name, c.content,
  c.start_offset, c.end_offset`;

const toChunk = (row: Row) => ({
  chunkId: row.chunk_id,
  documentId: row.document_id,
  displayName: row.display_name,
  content: row.content,
  startOffset: row.start_offset,
  endOffset: row.end_offset,
  score: Number(row.score),
});

export function createSearchRepository(executor: Executor): SearchRepository {
  return {
    async nearest({ workspaceId, model, embedding, limit }) {
      const query = `[${embedding.join(",")}]`;
      // Exact cosine scan.
      const { rows } = await executor.execute<Row>(sql`
        select ${columns}, 1 - (e.embedding <=> ${query}::vector) as score
        ${authorizedChunks}
        join chunk_embeddings e on e.chunk_id = c.id and e.workspace_id = c.workspace_id
        where ${authorizedWhere(workspaceId)} and e.model = ${model}
        order by e.embedding <=> ${query}::vector, c.id
        limit ${limit}`);
      return rows.map(toChunk);
    },

    async keyword({ workspaceId, query, limit }) {
      // The 'simple' regconfig is a literal in both places so a later expression index applies.
      // websearch_to_tsquery never raises on user input; a query without lexemes matches nothing.
      // A purely negated query ("-term") matches every chunk lacking the term with rank 0, so only
      // positively ranked matches are evidence.
      const { rows } = await executor.execute<Row>(sql`
        select * from (
          select ${columns},
                 ts_rank_cd(to_tsvector('simple', c.content), websearch_to_tsquery('simple', ${query})) as score
          ${authorizedChunks}
          where ${authorizedWhere(workspaceId)}
            and to_tsvector('simple', c.content) @@ websearch_to_tsquery('simple', ${query})
        ) ranked
        where score > 0
        order by score desc, chunk_id
        limit ${limit}`);
      return rows.map(toChunk);
    },
  };
}
