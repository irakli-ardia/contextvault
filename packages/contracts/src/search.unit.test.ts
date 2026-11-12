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
  scores: { vector: null, keyword: 0.1, fused: null },
  ranks: { vector: null, keyword: 1 },
};
const ok = { model: "m", mode: "keyword", results: [result] };

describe("parseSearchResponse", () => {
  it("accepts every mode and a vector result", () => {
    expect(SEARCH_MODES).toEqual(["vector", "keyword", "hybrid"]);
    expect(parseSearchResponse(ok)).toEqual(ok);
    const vector = {
      ...result,
      similarity: 0.5,
      scores: { vector: 0.5, keyword: null, fused: null },
      ranks: { vector: 1, keyword: null },
    };
    const body = { model: "m", mode: "vector", results: [vector] };
    expect(parseSearchResponse(body)).toEqual(body);
  });

  it.each([
    [null],
    [{ ...ok, mode: "bogus" }],
    [{ ...ok, extra: 1 }],
    [{ model: "m", mode: "keyword" }],
    [{ ...ok, results: [{ ...result, ranks: { vector: null, keyword: 0 } }] }],
    [{ ...ok, results: [{ ...result, scores: { vector: null, keyword: 0.1 } }] }],
    [{ ...ok, results: [{ ...result, startOffset: -1 }] }],
    [{ ...ok, results: [{ ...result, similarity: 0.5 }] }],
    [{ ...ok, results: [{ ...result, scores: { vector: 0.5, keyword: 0.1, fused: null } }] }],
    [{ ...ok, results: [{ ...result, extra: 1 }] }],
  ])("rejects %j", (value) => {
    expect(parseSearchResponse(value)).toBeNull();
  });
});

const both = {
  ...result,
  similarity: 0.5,
  scores: { vector: 0.5, keyword: 0.1, fused: 1 / 61 + 1 / 62 },
  ranks: { vector: 1, keyword: 2 },
};
const hybrid = (r: object) => ({ model: "m", mode: "hybrid", results: [r] });

describe("parseSearchResponse mode consistency", () => {
  it("accepts hybrid results found by both signals or by one", () => {
    const vectorOnly = {
      ...both,
      scores: { vector: 0.5, keyword: null, fused: 1 / 61 },
      ranks: { vector: 1, keyword: null },
    };
    const keywordOnly = {
      ...result,
      scores: { vector: null, keyword: 0.1, fused: 1 / 61 },
      ranks: { vector: null, keyword: 1 },
    };
    for (const r of [both, vectorOnly, keywordOnly]) {
      expect(parseSearchResponse(hybrid(r))).toEqual(hybrid(r));
    }
  });

  it.each([
    ["hybrid without a fused score", hybrid({ ...both, scores: { ...both.scores, fused: null } })],
    ["hybrid with a zero fused score", hybrid({ ...both, scores: { ...both.scores, fused: 0 } })],
    [
      "hybrid with no signal",
      hybrid({
        ...result,
        scores: { vector: null, keyword: null, fused: 0.1 },
        ranks: { vector: null, keyword: null },
      }),
    ],
    ["hybrid whose similarity is not the vector score", hybrid({ ...both, similarity: 0.4 })],
    ["a score without its rank", hybrid({ ...both, ranks: { vector: 1, keyword: null } })],
    ["a rank without its score", hybrid({ ...both, scores: { ...both.scores, keyword: null } })],
    [
      "a fused score in keyword mode",
      { ...ok, results: [{ ...result, scores: { ...result.scores, fused: 0.1 } }] },
    ],
    ["a vector signal in keyword mode", { ...ok, results: [both] }],
    [
      "a keyword signal in vector mode",
      {
        model: "m",
        mode: "vector",
        results: [{ ...both, scores: { ...both.scores, fused: null } }],
      },
    ],
    ["a keyword result in vector mode", { ...ok, mode: "vector" }],
    [
      "a vector result in keyword mode",
      {
        model: "m",
        mode: "keyword",
        results: [
          {
            ...both,
            scores: { ...both.scores, keyword: null, fused: null },
            ranks: { vector: 1, keyword: null },
          },
        ],
      },
    ],
  ])("rejects %s", (_name, body) => {
    expect(parseSearchResponse(body)).toBeNull();
  });
});
