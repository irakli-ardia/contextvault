import { DomainError } from "../kernel/errors";
import type { UnitOfWork } from "../kernel/unit-of-work";
import { type Actor, assertCan } from "../workspaces/permissions";
import type { Embedder } from "./embedder";

const maxQueryLength = 1_000;
const defaultSearchLimit = 5;
const maxSearchLimit = 20;

// Modes: `vector` embeds the query; `keyword` is PostgreSQL full-text search and never calls the embedder.
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

/** A signal's raw score and 1-based rank; `null` when that signal did not produce the chunk. */
export interface SearchHit extends Omit<ScoredChunk, "score"> {
  readonly scores: { readonly vector: number | null; readonly keyword: number | null };
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
    /** Untrusted: only "vector" (default) and "keyword" are accepted. */
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
  if (mode !== "vector" && mode !== "keyword") throw new InvalidSearch();
  const workspaceId = actor.workspaceId;
  const context = { userId: actor.userId, workspaceId };
  if (mode === "keyword") {
    const rows = await deps.uow.run(context, (repos) =>
      repos.search.keyword({ workspaceId, query, limit }),
    );
    return rows.map(({ score, ...chunk }, i) => ({
      ...chunk,
      scores: { vector: null, keyword: score },
      ranks: { vector: null, keyword: i + 1 },
    }));
  }
  // The network call happens before the transaction opens: none is held across it.
  const [embedding] = await deps.embedder.embed([query]);
  if (embedding === undefined) throw new Error("Embedder returned no vector");
  const rows = await deps.uow.run(context, (repos) =>
    repos.search.nearest({ workspaceId, model: deps.embedder.model, embedding, limit }),
  );
  return rows.map(({ score, ...chunk }, i) => ({
    ...chunk,
    scores: { vector: score, keyword: null },
    ranks: { vector: i + 1, keyword: null },
  }));
}
