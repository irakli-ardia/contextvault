import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "../kernel/ids";
import type { Embedder } from "./embedder";
import { InvalidSearch, type SearchRepository, searchChunks } from "./search-chunks";

const workspaceId = parseWorkspaceId("00000000-0000-4000-8000-000000000001");
const userId = parseUserId("00000000-0000-4000-8000-000000000002");
const actor = { userId, workspaceId, role: "member" } as const;

const row = (id: string, score: number) => ({
  chunkId: id,
  documentId: `doc-${id}`,
  displayName: `${id}.txt`,
  content: `content ${id}`,
  startOffset: 0,
  endOffset: 9,
  score,
});

function setup(nearestRows: ReturnType<typeof row>[] = []) {
  const embedded: string[][] = [];
  const asked: Parameters<SearchRepository["nearest"]>[0][] = [];
  const keywordAsked: Parameters<SearchRepository["keyword"]>[0][] = [];
  let inTransaction = false;
  const embedder: Embedder = {
    model: "m1",
    embed: async (texts) => {
      expect(inTransaction).toBe(false);
      embedded.push([...texts]);
      return texts.map(() => [1, 0]);
    },
  };
  const deps = {
    embedder,
    uow: {
      run: async <T>(
        _context: unknown,
        work: (repos: { search: SearchRepository }) => Promise<T>,
      ) => {
        inTransaction = true;
        try {
          return await work({
            search: {
              nearest: async (input) => {
                expect(inTransaction).toBe(true);
                asked.push(input);
                return nearestRows;
              },
              keyword: async (input) => {
                expect(inTransaction).toBe(true);
                keywordAsked.push(input);
                return [row("a", 0.4), row("b", 0.2)];
              },
            },
          });
        } finally {
          inTransaction = false;
        }
      },
    },
  };
  return { deps, embedded, asked, keywordAsked };
}

describe("searchChunks", () => {
  it("embeds the trimmed query outside the transaction and searches the actor's workspace", async () => {
    const { deps, embedded, asked } = setup();
    await searchChunks(deps, actor, { query: "  refunds  " });
    expect(embedded).toEqual([["refunds"]]);
    expect(asked).toEqual([{ workspaceId, model: "m1", embedding: [1, 0], limit: 5 }]);
  });

  it("keyword mode never embeds and reports the keyword score and rank only", async () => {
    const { deps, embedded, asked, keywordAsked } = setup();
    const hits = await searchChunks(deps, actor, { query: "  INV-42 ", mode: "keyword", limit: 3 });
    expect(embedded).toEqual([]);
    expect(asked).toEqual([]);
    expect(keywordAsked).toEqual([{ workspaceId, query: "INV-42", limit: 3 }]);
    expect(hits.map((h) => [h.chunkId, h.scores, h.ranks])).toEqual([
      ["a", { vector: null, keyword: 0.4, fused: null }, { vector: null, keyword: 1 }],
      ["b", { vector: null, keyword: 0.2, fused: null }, { vector: null, keyword: 2 }],
    ]);
  });

  it("hybrid embeds outside the transaction, asks both signals for 50 in one, and fuses", async () => {
    const { deps, embedded, asked, keywordAsked } = setup([row("b", 0.9), row("c", 0.5)]);
    const hits = await searchChunks(deps, actor, { query: " refunds ", mode: "hybrid", limit: 2 });
    expect(embedded).toEqual([["refunds"]]);
    expect(asked).toEqual([{ workspaceId, model: "m1", embedding: [1, 0], limit: 50 }]);
    expect(keywordAsked).toEqual([{ workspaceId, query: "refunds", limit: 50 }]);
    // keyword returns a, b; vector returns b, c -> b is in both signals.
    expect(hits.map((h) => h.chunkId)).toEqual(["b", "a"]);
    expect(hits[0]).toMatchObject({
      scores: { vector: 0.9, keyword: 0.2, fused: 1 / 61 + 1 / 62 },
      ranks: { vector: 1, keyword: 2 },
    });
  });

  it("vector and keyword modes never report a fused score", async () => {
    const { deps } = setup([row("a", 0.9)]);
    const vector = await searchChunks(deps, actor, { query: "x" });
    const keyword = await searchChunks(deps, actor, { query: "x", mode: "keyword" });
    expect([...vector, ...keyword].map((h) => h.scores.fused)).toEqual([null, null, null]);
  });

  it("defaults to vector mode and never queries the keyword index", async () => {
    const { deps, keywordAsked } = setup();
    await searchChunks(deps, actor, { query: "refunds", mode: undefined });
    expect(keywordAsked).toEqual([]);
  });

  it.each([
    [{ query: "   " }],
    [{ query: "x".repeat(1_001) }],
    [{ query: "ok", limit: 0 }],
    [{ query: "ok", limit: 21 }],
    [{ query: "ok", limit: 1.5 }],
    [{ query: "   ", mode: "keyword" as const }],
    [{ query: "ok", mode: "bogus" }],
    [{ query: "ok", mode: "Hybrid" }],
    [{ query: "   ", mode: "hybrid" as const }],
    [{ query: "ok", limit: 21, mode: "hybrid" as const }],
    [{ query: "ok", limit: 21, mode: "keyword" as const }],
  ])("rejects %j before any provider call", async (input) => {
    const { deps, embedded } = setup();
    await expect(searchChunks(deps, actor, input)).rejects.toBeInstanceOf(InvalidSearch);
    expect(embedded).toEqual([]);
  });
});
