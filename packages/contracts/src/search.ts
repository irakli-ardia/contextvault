// Response shape of POST /workspaces/{workspaceId}/search. Scores are raw per-signal values and are
// never comparable across signals: cosine is in [-1, 1], the keyword score is corpus-relative.
// `fused` (Reciprocal Rank Fusion) only orders hybrid results; it is not a relevance score.

export const SEARCH_MODES = ["vector", "keyword", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export interface SearchResult {
  readonly chunkId: string;
  readonly documentId: string;
  readonly displayName: string;
  readonly content: string;
  readonly startOffset: number;
  readonly endOffset: number;
  /** Cosine similarity; `null` when the chunk was not found by vector search. */
  readonly similarity: number | null;
  readonly scores: {
    readonly vector: number | null;
    readonly keyword: number | null;
    readonly fused: number | null;
  };
  readonly ranks: { readonly vector: number | null; readonly keyword: number | null };
}

export interface SearchResponse {
  /** The embedding model, also in keyword mode (stable shape). */
  readonly model: string;
  readonly mode: SearchMode;
  readonly results: readonly SearchResult[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isOffset = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isScore = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const isRank = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isInteger(value) && value >= 1);

function parseScores(value: unknown) {
  if (!isRecord(value) || Object.keys(value).length !== 3) return null;
  const { vector, keyword, fused } = value;
  return isScore(vector) && isScore(keyword) && isScore(fused) ? { vector, keyword, fused } : null;
}

function parseRanks(value: unknown) {
  if (!isRecord(value) || Object.keys(value).length !== 2) return null;
  const { vector, keyword } = value;
  return isRank(vector) && isRank(keyword) ? { vector, keyword } : null;
}

// A signal has a score exactly when it has a rank, and the mode decides which signals exist:
// a single-signal response has only its own and no fused score; hybrid has a fused score and
// at least one signal behind it.
function consistent(
  mode: SearchMode,
  scores: SearchResult["scores"],
  ranks: SearchResult["ranks"],
) {
  if ((scores.vector === null) !== (ranks.vector === null)) return false;
  if ((scores.keyword === null) !== (ranks.keyword === null)) return false;
  const hasVector = scores.vector !== null;
  const hasKeyword = scores.keyword !== null;
  if (mode === "vector") return hasVector && !hasKeyword && scores.fused === null;
  if (mode === "keyword") return hasKeyword && !hasVector && scores.fused === null;
  return (hasVector || hasKeyword) && scores.fused !== null && scores.fused > 0;
}

function parseResult(value: unknown, mode: SearchMode): SearchResult | null {
  if (!isRecord(value) || Object.keys(value).length !== 9) return null;
  const { chunkId, documentId, displayName, content, startOffset, endOffset, similarity } = value;
  if (typeof chunkId !== "string" || typeof documentId !== "string") return null;
  if (typeof displayName !== "string" || typeof content !== "string") return null;
  if (!isOffset(startOffset) || !isOffset(endOffset) || !isScore(similarity)) return null;
  const scores = parseScores(value["scores"]);
  const ranks = parseRanks(value["ranks"]);
  if (scores === null || ranks === null || similarity !== scores.vector) return null;
  if (!consistent(mode, scores, ranks)) return null;
  return {
    chunkId,
    documentId,
    displayName,
    content,
    startOffset,
    endOffset,
    similarity,
    scores,
    ranks,
  };
}

/** Runtime check of an untrusted body; `null` when it is not exactly a `SearchResponse`. */
export function parseSearchResponse(value: unknown): SearchResponse | null {
  if (!isRecord(value) || Object.keys(value).length !== 3) return null;
  const { model, mode, results } = value;
  if (typeof model !== "string" || !Array.isArray(results)) return null;
  if (mode !== "vector" && mode !== "keyword" && mode !== "hybrid") return null;
  const parsed = results.map((result) => parseResult(result, mode));
  const valid = parsed.filter((r): r is SearchResult => r !== null);
  return valid.length === parsed.length ? { model, mode, results: valid } : null;
}
