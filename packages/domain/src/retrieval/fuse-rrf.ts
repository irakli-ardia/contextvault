import type { ScoredChunk, SearchHit } from "./search-chunks";

/** Standard RRF damping constant; fixed until retrieval quality is measured (M4). */
export const rrfK = 60;
/** Candidates each signal contributes to the fusion. */
export const rrfPoolSize = 50;

type Signal = "vector" | "keyword";
interface Entry {
  chunk: Omit<ScoredChunk, "score">;
  scores: Record<Signal, number | null>;
  ranks: Record<Signal, number | null>;
}

/**
 * Reciprocal Rank Fusion: `fused = Σ 1/(rrfK + rank)` over the signals that returned the chunk, with
 * 1-based ranks taken from list position. Raw scores are carried along but never compared, since
 * cosine and `ts_rank_cd` share no scale. Order is total, so equal inputs always give equal output:
 * fused score desc, then the chunk's best single-signal rank, then chunk id (bytewise, as uuids
 * compare in PostgreSQL). Only the first `rrfPoolSize` candidates of each list count.
 */
export function fuseRrf(
  lists: { readonly vector: readonly ScoredChunk[]; readonly keyword: readonly ScoredChunk[] },
  limit: number,
): SearchHit[] {
  const entries = new Map<string, Entry>();
  for (const signal of ["vector", "keyword"] as const) {
    lists[signal].slice(0, rrfPoolSize).forEach(({ score, ...chunk }, index) => {
      const entry = entries.get(chunk.chunkId) ?? {
        chunk,
        scores: { vector: null, keyword: null },
        ranks: { vector: null, keyword: null },
      };
      // A repeated candidate keeps its best (first) rank so it cannot be counted twice.
      if (entry.ranks[signal] !== null) return;
      entry.scores[signal] = score;
      entry.ranks[signal] = index + 1;
      entries.set(chunk.chunkId, entry);
    });
  }
  const bestRank = ({ ranks }: Entry) =>
    Math.min(ranks.vector ?? Infinity, ranks.keyword ?? Infinity);
  // Fixed addition order (vector, then keyword): float addition is commutative, so equal rank
  // pairs give bit-identical sums and fall through to the tie-breakers.
  const fused = ({ ranks }: Entry) =>
    (ranks.vector === null ? 0 : 1 / (rrfK + ranks.vector)) +
    (ranks.keyword === null ? 0 : 1 / (rrfK + ranks.keyword));
  return [...entries.values()]
    .map((entry) => ({ entry, fused: fused(entry) }))
    .sort(
      (a, b) =>
        b.fused - a.fused ||
        bestRank(a.entry) - bestRank(b.entry) ||
        (a.entry.chunk.chunkId < b.entry.chunk.chunkId ? -1 : 1),
    )
    .slice(0, limit)
    .map(({ entry, fused: score }) => ({
      ...entry.chunk,
      scores: { ...entry.scores, fused: score },
      ranks: entry.ranks,
    }));
}
