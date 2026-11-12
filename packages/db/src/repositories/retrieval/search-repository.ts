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
  similarity: number;
}

// Exact cosine search. Every authorization condition is in this one statement, not applied to its
// result: the workspace (also enforced by RLS), a live document, and the document's *active* ready
// version, so superseded, failed, unfinished and deleted versions have no rows to return.
export function createSearchRepository(executor: Executor): SearchRepository {
  return {
    async nearest({ workspaceId, model, embedding, limit }) {
      const query = `[${embedding.join(",")}]`;
      const { rows } = await executor.execute<Row>(sql`
        select c.id as chunk_id, d.id as document_id, d.display_name, c.content,
               c.start_offset, c.end_offset, 1 - (e.embedding <=> ${query}::vector) as similarity
        from chunk_embeddings e
        join chunks c on c.id = e.chunk_id and c.workspace_id = e.workspace_id
        join document_versions v on v.id = c.version_id and v.workspace_id = c.workspace_id
        join documents d on d.id = v.document_id and d.workspace_id = v.workspace_id
          and d.active_version_id = v.id
        where e.workspace_id = ${workspaceId} and e.model = ${model}
          and d.deleted_at is null and v.status = 'ready'
        order by e.embedding <=> ${query}::vector, c.id
        limit ${limit}`);
      return rows.map((row) => ({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        displayName: row.display_name,
        content: row.content,
        startOffset: row.start_offset,
        endOffset: row.end_offset,
        similarity: Number(row.similarity),
      }));
    },
  };
}
