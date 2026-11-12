import { describe, expect, it } from "vitest";
import { parseSearchResponse, SEARCH_MODES } from "./search";

const result = {
  chunkId: "c",
  documentId: "d",
  displayName: "n.txt",
  content: "abc",
  startOffset: 0,
  endOffset: 3,
  similarity: null,
  scores: { vector: null, keyword: 0.1 },
  ranks: { vector: null, keyword: 1 },
};
const ok = { model: "m", mode: "keyword", results: [result] };

describe("parseSearchResponse", () => {
  it("accepts every mode and a vector result", () => {
    expect(SEARCH_MODES).toEqual(["vector", "keyword"]);
    expect(parseSearchResponse(ok)).toEqual(ok);
    const vector = {
      ...result,
      similarity: 0.5,
      scores: { vector: 0.5, keyword: null },
      ranks: { vector: 1, keyword: null },
    };
    const body = { model: "m", mode: "vector", results: [vector] };
    expect(parseSearchResponse(body)).toEqual(body);
  });

  it.each([
    [null],
    [{ ...ok, mode: "hybrid" }],
    [{ ...ok, extra: 1 }],
    [{ model: "m", mode: "keyword" }],
    [{ ...ok, results: [{ ...result, ranks: { vector: null, keyword: 0 } }] }],
    [{ ...ok, results: [{ ...result, scores: { vector: null } }] }],
    [{ ...ok, results: [{ ...result, startOffset: -1 }] }],
    [{ ...ok, results: [{ ...result, similarity: 0.5 }] }],
    [{ ...ok, results: [{ ...result, scores: { vector: 0.5, keyword: 0.1 } }] }],
    [{ ...ok, results: [{ ...result, extra: 1 }] }],
  ])("rejects %j", (value) => {
    expect(parseSearchResponse(value)).toBeNull();
  });
});
