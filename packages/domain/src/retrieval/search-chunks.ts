import { DomainError } from "../kernel/errors";
import type { UnitOfWork } from "../kernel/unit-of-work";
import { type Actor, assertCan } from "../workspaces/permissions";
import type { Embedder } from "./embedder";
import { fuseRrf, rrfPoolSize } from "./fuse-rrf";

// Exported so the HTTP schema rejects exactly what the use case rejects, before the rate limiter.
export const maxQueryLength = 1_000;
const defaultSearchLimit = 5;
export const maxSearchLimit = 20;

// Modes: `vector` embeds the query; `keyword` is PostgreSQL full-text search and never calls the
// embedder; `hybrid` fuses both candidate lists with Reciprocal Rank Fusion.
export interface ScoredChunk {
  readonly chunkId: string;
  readonly documentId: string;
  readonly displayName: string;
  readonly content: string;
  readonly startOffset: number;
  readonly endOffset: number;
  /** Raw signal score: cosine in [-1, 1] for `vector`, unbounded corpus-relative `ts_rank_cd` for `keyword`. */
  readonly score: number;
}

/**
 * A signal's raw score and 1-based rank; `null` when that signal did not produce the chunk.
 * `fused` (RRF) exists only in hybrid mode and is an ordering value, not a relevance score.
 */
export interface SearchHit extends Omit<ScoredChunk, "score"> {
  readonly scores: {
    readonly vector: number | null;
    readonly keyword: number | null;
    readonly fused: number | null;
  };
  readonly ranks: { readonly vector: number | null; readonly keyword: number | null };
}

export interface SearchRepository {
  /**
   * Nearest chunks of the workspace's live documents: only the active, ready version, only
   * vectors of `model`. Authorization is part of the query, not applied afterwards.
   */
  nearest(input: {
    readonly workspaceId: string;
    readonly model: string;
    readonly embedding: readonly number[];
    readonly limit: number;
  }): Promise<readonly ScoredChunk[]>;
  /** Full-text matches (all query terms) under the same authorization as `nearest`. */
  keyword(input: {
    readonly workspaceId: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly ScoredChunk[]>;
}

export interface SearchChunksDeps {
  readonly uow: UnitOfWork<{ search: SearchRepository }>;
  readonly embedder: Embedder;
}

/** A blank or oversized query, a limit outside 1..maxSearchLimit, or an unknown mode. */
export class InvalidSearch extends DomainError {
  constructor() {
    super("search.invalid", "Invalid search request");
  }
}

export async function searchChunks(
  deps: SearchChunksDeps,
  actor: Actor,
  input: {
    readonly query: string;
    readonly limit?: number | undefined;
    /** Untrusted: only "vector" (default), "keyword" and "hybrid" are accepted. */
    readonly mode?: string | undefined;
  },
): Promise<readonly SearchHit[]> {
  assertCan(actor, "document.read");
  const query = input.query.trim();
  const limit = input.limit ?? defaultSearchLimit;
  const mode = input.mode ?? "vector";
  if (query === "" || query.length > maxQueryLength) throw new InvalidSearch();
  if (!Number.isInteger(limit) || limit < 1 || limit > maxSearchLimit) throw new InvalidSearch();
  // Checked before any provider call: an unknown mode must not fall through to the embedder.
  if (mode !== "vector" && mode !== "keyword" && mode !== "hybrid") throw new InvalidSearch();
  const workspaceId = actor.workspaceId;
  const context = { userId: actor.userId, workspaceId };
  if (mode === "keyword") {
    const rows = await deps.uow.run(context, (repos) =>
      repos.search.keyword({ workspaceId, query, limit }),
    );
    return rows.map(({ score, ...chunk }, i) => ({
      ...chunk,
      scores: { vector: null, keyword: score, fused: null },
      ranks: { vector: null, keyword: i + 1 },
    }));
  }
  // The network call happens before the transaction opens: none is held across it.
  const [embedding] = await deps.embedder.embed([query]);
  if (embedding === undefined) throw new Error("Embedder returned no vector");
  const model = deps.embedder.model;
  if (mode === "hybrid") {
    // One transaction, both signals under the same authorization; fusion only sees returned rows.
    // No isolation level is set, so this is the server default (READ COMMITTED, pinned by an
    // integration test): the two statements may see different snapshots. A concurrent delete or
    // activation can drop a chunk from one signal, never add one: each statement carries its own
    // authorization predicate and RLS check, and fusion keys on chunk id.
    const lists = await deps.uow.run(context, async (repos) => ({
      vector: await repos.search.nearest({
        workspaceId,
        model,
        embedding,
        limit: rrfPoolSize,
      }),
      keyword: await repos.search.keyword({ workspaceId, query, limit: rrfPoolSize }),
    }));
    return fuseRrf(lists, limit);
  }
  const rows = await deps.uow.run(context, (repos) =>
    repos.search.nearest({ workspaceId, model, embedding, limit }),
  );
  return rows.map(({ score, ...chunk }, i) => ({
    ...chunk,
    scores: { vector: score, keyword: null, fused: null },
    ranks: { vector: i + 1, keyword: null },
  }));
}
