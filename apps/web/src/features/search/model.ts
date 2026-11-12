import { SEARCH_MODES, type SearchMode, type SearchResult } from "@contextvault/contracts";
import type { ModeOutcome } from "./api";
import { searchErrorMessage } from "./messages";

export type ModeChoice = SearchMode | "compare";

export const CHOICES: readonly { value: ModeChoice; label: string }[] = [
  { value: "hybrid", label: "Hybrid" },
  { value: "vector", label: "Vector" },
  { value: "keyword", label: "Keyword" },
  { value: "compare", label: "Compare all" },
];

export const MODE_TITLE: Record<SearchMode, string> = {
  vector: "Vector",
  keyword: "Keyword",
  hybrid: "Hybrid",
};

export const MODE_NOTE: Record<SearchMode, string> = {
  vector:
    "Ordered by embedding similarity (cosine). Returns the nearest chunks even when nothing matches the query, so read the score.",
  keyword: "Ordered by full-text rank. All query terms must match.",
  hybrid: "Vector and keyword lists fused by rank (RRF).",
};

export const modesFor = (choice: ModeChoice): readonly SearchMode[] =>
  choice === "compare" ? SEARCH_MODES : [choice];

export interface ScoreLine {
  readonly label: string;
  readonly value: string;
}

// Raw values only. The three signals are different scales (cosine in [-1, 1], an unbounded
// corpus-relative keyword score, a rank-derived fused value), so none is shown as a percentage
// and none is normalised against another.
const raw = (score: number, rank: number) => `${score.toFixed(4)} · rank ${rank}`;

export function scoreLines(result: SearchResult, mode: SearchMode): ScoreLine[] {
  const { scores, ranks } = result;
  const vector: ScoreLine =
    scores.vector !== null && ranks.vector !== null
      ? { label: "Vector similarity (cosine)", value: raw(scores.vector, ranks.vector) }
      : { label: "Vector similarity (cosine)", value: "not found by vector search" };
  const keyword: ScoreLine =
    scores.keyword !== null && ranks.keyword !== null
      ? { label: "Keyword rank score", value: raw(scores.keyword, ranks.keyword) }
      : { label: "Keyword rank score", value: "not found by keyword search" };
  if (mode === "vector") return [vector];
  if (mode === "keyword") return [keyword];
  const fused: ScoreLine = {
    label: "RRF order value (not a relevance score)",
    value: scores.fused === null ? "none" : scores.fused.toFixed(6),
  };
  return [fused, vector, keyword];
}

export const resultCount = (count: number): string =>
  count === 0 ? "No results." : `${count} ${count === 1 ? "result" : "results"}.`;

export const outcomeText = (outcome: ModeOutcome): string =>
  outcome.ok ? resultCount(outcome.response.results.length) : searchErrorMessage(outcome.error);

/** One sentence per mode for the panel's single live region. */
export const announcement = (outcomes: readonly ModeOutcome[]): string =>
  outcomes.map((outcome) => `${MODE_TITLE[outcome.mode]}: ${outcomeText(outcome)}`).join(" ");

export function liveStatus(pending: boolean, outcomes: readonly ModeOutcome[] | undefined): string {
  if (pending) return "Searching…";
  return outcomes === undefined ? "" : `Search complete. ${announcement(outcomes)}`;
}
