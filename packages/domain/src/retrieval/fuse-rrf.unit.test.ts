import { describe, expect, it } from "vitest";
import { fuseRrf, rrfK, rrfPoolSize } from "./fuse-rrf";
import type { ScoredChunk } from "./search-chunks";

const chunk = (id: string, score = 0.5): ScoredChunk => ({
  chunkId: id,
  documentId: `doc-${id}`,
  displayName: `${id}.txt`,
  content: `content ${id}`,
  startOffset: 0,
  endOffset: 9,
  score,
});
const list = (...ids: string[]) => ids.map((id, i) => chunk(id, 1 - i / 10));
const fuse = (vector: ScoredChunk[], keyword: ScoredChunk[], limit = 20) =>
  fuseRrf({ vector, keyword }, limit);
const ids = (hits: { chunkId: string }[]) => hits.map((h) => h.chunkId);

describe("fuseRrf", () => {
  it("pins the constants", () => {
    expect([rrfK, rrfPoolSize]).toEqual([60, 50]);
  });

  it("scores 1/(60 + rank) per signal with 1-based ranks and carries the raw scores", () => {
    const [a, b] = fuse([chunk("a", 0.9), chunk("b", 0.8)], [chunk("b", 4), chunk("c", 2)]);
    expect(a).toMatchObject({
      chunkId: "b",
      scores: { vector: 0.8, keyword: 4, fused: 1 / 62 + 1 / 61 },
      ranks: { vector: 2, keyword: 1 },
    });
    expect(b).toMatchObject({
      chunkId: "a",
      scores: { vector: 0.9, keyword: null, fused: 1 / 61 },
      ranks: { vector: 1, keyword: null },
    });
  });

  it("ranks a chunk found by both signals above one found by a single signal", () => {
    expect(ids(fuse(list("a", "b", "c"), list("z", "y", "c")))).toEqual(["c", "a", "z", "b", "y"]);
  });

  it("breaks equal fused scores by best single-signal rank, then chunk id", () => {
    // x: vector 1 + keyword 2, y: vector 2 + keyword 1 -> bit-identical sums, equal best rank.
    expect(ids(fuse(list("y", "x"), list("x", "y")))).toEqual(["x", "y"]);
    // One signal each at the same rank: equal fused and best rank, so id decides.
    expect(ids(fuse(list("b"), list("a")))).toEqual(["a", "b"]);
  });

  it("takes ranks from list position, so reordering a list reorders the output", () => {
    const forward = fuse(list("a", "b"), list("c", "d"));
    const swapped = fuse(list("b", "a"), list("d", "c"));
    expect(ids(forward)).toEqual(["a", "c", "b", "d"]);
    expect(ids(swapped)).toEqual(["b", "d", "a", "c"]);
    expect(fuse(list("a", "b"), list("c", "d"))).toEqual(forward);
  });

  it("handles an empty signal on either side, and both", () => {
    expect(ids(fuse([], list("a", "b")))).toEqual(["a", "b"]);
    expect(ids(fuse(list("a", "b"), []))).toEqual(["a", "b"]);
    expect(fuse([], [])).toEqual([]);
    expect(fuse([], list("a"))[0]).toMatchObject({
      scores: { vector: null, fused: 1 / 61 },
      ranks: { vector: null, keyword: 1 },
    });
  });

  it("counts a repeated candidate once, at its best rank", () => {
    const [only] = fuse([chunk("a", 0.9), chunk("a", 0.1)], []);
    expect(only).toMatchObject({ scores: { vector: 0.9, fused: 1 / 61 }, ranks: { vector: 1 } });
  });

  it("uses only the first 50 candidates of each signal", () => {
    const many = Array.from({ length: 60 }, (_, i) => `c${String(i).padStart(2, "0")}`);
    const hits = fuse(list(...many), [], 100);
    expect(hits).toHaveLength(rrfPoolSize);
    expect(hits.at(-1)?.ranks.vector).toBe(50);
  });

  it("truncates to the limit after ordering", () => {
    expect(ids(fuse(list("a", "b", "c"), list("c", "b", "a"), 2))).toEqual(["a", "c"]);
  });

  it("is deterministic and does not modify its input", () => {
    const vector = list("a", "b", "c");
    const keyword = list("c", "d");
    const snapshot = JSON.parse(JSON.stringify({ vector, keyword }));
    expect(fuse(vector, keyword)).toEqual(fuse(vector, keyword));
    expect({ vector, keyword }).toEqual(snapshot);
  });
});
