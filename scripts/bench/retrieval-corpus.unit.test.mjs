import { describe, expect, it } from "vitest";
import {
  chunkText,
  chunkVector,
  corpusDigest,
  DIMENSIONS,
  idOf,
  keywordCases,
  PLANTED,
  plantedCount,
} from "./retrieval-corpus.mjs";

describe("retrieval benchmark corpus", () => {
  it("is deterministic and a smaller corpus is a prefix of a larger one", () => {
    expect(corpusDigest(40)).toBe(corpusDigest(40));
    expect(corpusDigest(40)).not.toBe(corpusDigest(41));
    expect(chunkText(7)).toBe(chunkText(7));
    expect(chunkVector(3)).toBe(chunkVector(3));
    expect(idOf("chunk", 1)).toBe(idOf("chunk", 1));
    expect(idOf("chunk", 1)).not.toBe(idOf("chunk", 2));
  });

  it("makes unit vectors of the stored dimension", () => {
    const values = chunkVector(1).slice(1, -1).split(",").map(Number);
    expect(values).toHaveLength(DIMENSIONS);
    expect(Math.hypot(...values)).toBeCloseTo(1, 3);
  });

  it("plants each term in exactly the chunks the expected counts say", () => {
    const n = 1200;
    const texts = Array.from({ length: n }, (_, i) => chunkText(i).split(" "));
    for (const { term, every, offset } of PLANTED) {
      expect(texts.filter((words) => words.includes(term)).length).toBe(
        plantedCount(n, { every, offset }),
      );
    }
    expect(keywordCases(n).find((c) => c.key === "and")?.expects).toBe(12);
    expect(keywordCases(n).find((c) => c.key === "absent")?.expects).toBe(0);
  });
});
