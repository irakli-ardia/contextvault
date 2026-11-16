import { describe, expect, it } from "vitest";
import { verifyCounts, versionRows } from "./ingestion-bench-rows.mjs";

const item = (versionId, over = {}) => ({
  versionId,
  cls: "small",
  text: "abcd",
  expectedChunks: 3,
  ...over,
});
const row = (id, over = {}) => ({ id, status: "ready", chunks: 3, embeddings: 3, ...over });

describe("verifyCounts", () => {
  it("accepts accepted documents with the predicted chunks and one embedding each", () => {
    expect(verifyCounts([item("a")], [row("a")])).toMatchObject({
      ok: true,
      mismatchedVersions: 0,
    });
  });
  it.each([
    [
      "a version that never became ready",
      row("a", { status: "failed", chunks: 0, embeddings: 0 }),
      /status failed/,
    ],
    [
      "a chunk count other than the chunker's",
      row("a", { chunks: 2, embeddings: 2 }),
      /chunks 2, expected 3/,
    ],
    ["missing embeddings", row("a", { embeddings: 1 }), /embeddings 1/],
    [
      "zero chunks for an accepted document",
      row("a", { chunks: 0, embeddings: 0 }),
      /chunks 0, expected 3/,
    ],
  ])("flags %s", (_, r, reason) => {
    const result = verifyCounts([item("a")], [r]);
    expect(result.ok).toBe(false);
    expect(result.problems[0].reason).toMatch(reason);
  });
  it("flags a version the database does not hold", () => {
    expect(verifyCounts([item("a")], []).problems[0].reason).toBe("version missing");
  });
  it("requires a rejected document to have no chunks and not to be ready", () => {
    const rejected = item("a", { expect: "rejected" });
    expect(
      verifyCounts([rejected], [row("a", { status: "failed", chunks: 0, embeddings: 0 })]).ok,
    ).toBe(true);
    expect(verifyCounts([rejected], [row("a")]).ok).toBe(false);
  });
});

describe("versionRows timing", () => {
  const events = [
    {
      type: "uow",
      call: 1,
      startMs: 110,
      endMs: 120,
      methods: [{ method: "claim", versionId: "a" }],
    },
    {
      type: "stage",
      stage: "parsing",
      versionId: "a",
      startMs: 120,
      endMs: 170,
      sub: { readMs: 5, parseMs: 40 },
    },
    {
      type: "stage",
      stage: "chunking",
      versionId: "a",
      startMs: 170,
      endMs: 270,
      sub: { embedMs: 60 },
    },
    {
      type: "uow",
      call: 2,
      startMs: 270,
      endMs: 330,
      methods: [{ method: "activate", versionId: "a" }],
    },
  ];
  const tx = { tag: 2, totalMs: 55, commitMs: 4, labels: { chunks: [20, 10], embeddings: [15] } };
  const [r] = versionRows([item("a")], events, [tx], new Map([["a", 100]]));
  it("separates end-to-end (with queue wait) from worker-side processing", () => {
    expect(r).toMatchObject({ queueWaitMs: 10, endToEndMs: 230, processingMs: 220 });
  });
  it("keeps stage, unit-of-work and client-observed transaction timings apart", () => {
    expect(r).toMatchObject({
      parseStageMs: 50,
      chunkStageMs: 100,
      embedMs: 60,
      chunkingMs: 40,
      activateUowMs: 60,
    });
    expect(r.activation).toMatchObject({
      activationTxMs: 55,
      chunkInsertClientMs: 30,
      embeddingInsertClientMs: 15,
      commitClientMs: 4,
    });
    expect(r.activation).not.toHaveProperty("chunkInsertMs");
  });
  it("leaves worker timings null for a version that never activated", () => {
    const [none] = versionRows([item("b")], [], [], new Map([["b", 0]]));
    expect(none).toMatchObject({ processingMs: null, endToEndMs: null, activation: null });
  });
});
