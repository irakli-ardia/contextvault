import type { SearchResult } from "@contextvault/contracts";
import { describe, expect, it } from "vitest";
import { HttpError } from "../../lib/http-client";
import type { ModeOutcome } from "./api";
import { announcement, modesFor, resultCount, scoreLines } from "./model";

const base = {
  chunkId: "c",
  documentId: "d",
  displayName: "a.txt",
  content: "x",
  startOffset: 0,
  endOffset: 1,
};
const hybrid: SearchResult = {
  ...base,
  similarity: 0.25,
  scores: { vector: 0.25, keyword: null, fused: 1 / 61 },
  ranks: { vector: 1, keyword: null },
};

describe("search model", () => {
  it("expands compare into all three modes and a single choice into itself", () => {
    expect(modesFor("compare")).toEqual(["vector", "keyword", "hybrid"]);
    expect(modesFor("keyword")).toEqual(["keyword"]);
  });

  it("labels each signal separately and never normalises", () => {
    expect(scoreLines(hybrid, "hybrid")).toEqual([
      { label: "RRF order value (not a relevance score)", value: "0.016393" },
      { label: "Vector similarity (cosine)", value: "0.2500 · rank 1" },
      { label: "Keyword rank score", value: "not found by keyword search" },
    ]);
  });

  it("shows only the mode's own signal in single-signal modes", () => {
    const vector = { ...hybrid, scores: { ...hybrid.scores, fused: null } };
    expect(scoreLines(vector, "vector")).toEqual([
      { label: "Vector similarity (cosine)", value: "0.2500 · rank 1" },
    ]);
    const keyword: SearchResult = {
      ...base,
      similarity: null,
      scores: { vector: null, keyword: 0.0607, fused: null },
      ranks: { vector: null, keyword: 2 },
    };
    expect(scoreLines(keyword, "keyword")).toEqual([
      { label: "Keyword rank score", value: "0.0607 · rank 2" },
    ]);
  });

  it("counts results in words", () => {
    expect(resultCount(0)).toBe("No results.");
    expect(resultCount(1)).toBe("1 result.");
    expect(resultCount(3)).toBe("3 results.");
  });

  it("labels a hybrid result found by both signals with both raw values and the fused order", () => {
    const both: SearchResult = {
      ...hybrid,
      scores: { vector: 0.5, keyword: 0.0607, fused: 2 / 61 },
      ranks: { vector: 1, keyword: 1 },
    };
    expect(scoreLines(both, "hybrid").map((line) => line.value)).toEqual([
      "0.032787",
      "0.5000 · rank 1",
      "0.0607 · rank 1",
    ]);
  });

  it("summarises every mode, successes and failures, for one live region", () => {
    const outcomes: ModeOutcome[] = [
      { mode: "vector", ok: false, error: new HttpError(429, "search.throttled", null, 9) },
      { mode: "keyword", ok: true, response: { model: "m", mode: "keyword", results: [] } },
    ];
    expect(announcement(outcomes)).toBe(
      "Vector: Too many searches. Wait 9 s and try again. Keyword: No results.",
    );
  });
});
