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

describe("parseSearchResponse non-finite scores and result order", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a %s score in every score field",
    (bad) => {
      expect(
        parseSearchResponse({
          ...ok,
          results: [{ ...result, scores: { ...result.scores, keyword: bad } }],
        }),
      ).toBeNull();
      expect(
        parseSearchResponse(
          hybrid({ ...both, scores: { ...both.scores, vector: bad }, similarity: bad }),
        ),
      ).toBeNull();
      expect(
        parseSearchResponse(hybrid({ ...both, scores: { ...both.scores, fused: bad } })),
      ).toBeNull();
    },
  );

  const keywordAt = (rank: number, fused: number | null = null) => ({
    ...result,
    chunkId: `c${rank}`,
    scores: { vector: null, keyword: 0.1, fused },
    ranks: { vector: null, keyword: rank },
  });

  it("accepts single-signal results numbered 1..n in order", () => {
    const body = { ...ok, results: [keywordAt(1), keywordAt(2)] };
    expect(parseSearchResponse(body)).toEqual(body);
  });

  it.each([
    ["a repeated rank", [keywordAt(1), keywordAt(1)]],
    ["a rank gap", [keywordAt(1), keywordAt(3)]],
    ["ranks out of order", [keywordAt(2), keywordAt(1)]],
  ])("rejects %s in keyword mode", (_name, results) => {
    expect(parseSearchResponse({ ...ok, results })).toBeNull();
  });

  it("rejects hybrid results whose fused score increases or whose signal rank repeats", () => {
    const low = { ...keywordAt(2, 1 / 62) };
    const high = { ...keywordAt(1, 1 / 61) };
    expect(
      parseSearchResponse({ model: "m", mode: "hybrid", results: [high, low] }),
    ).not.toBeNull();
    expect(parseSearchResponse({ model: "m", mode: "hybrid", results: [low, high] })).toBeNull();
    expect(
      parseSearchResponse({
        model: "m",
        mode: "hybrid",
        results: [high, { ...high, chunkId: "x" }],
      }),
    ).toBeNull();
  });
});
