import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "../kernel/ids";
import type { Embedder } from "./embedder";
import { InvalidSearch, type SearchRepository, searchChunks } from "./search-chunks";

const workspaceId = parseWorkspaceId("00000000-0000-4000-8000-000000000001");
const userId = parseUserId("00000000-0000-4000-8000-000000000002");
const actor = { userId, workspaceId, role: "member" } as const;

function setup() {
  const embedded: string[][] = [];
  const asked: Parameters<SearchRepository["nearest"]>[0][] = [];
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
                asked.push(input);
                return [];
              },
            },
          });
        } finally {
          inTransaction = false;
        }
      },
    },
  };
  return { deps, embedded, asked };
}

describe("searchChunks", () => {
  it("embeds the trimmed query outside the transaction and searches the actor's workspace", async () => {
    const { deps, embedded, asked } = setup();
    await searchChunks(deps, actor, { query: "  refunds  " });
    expect(embedded).toEqual([["refunds"]]);
    expect(asked).toEqual([{ workspaceId, model: "m1", embedding: [1, 0], limit: 5 }]);
  });

  it.each([
    [{ query: "   " }],
    [{ query: "x".repeat(1_001) }],
    [{ query: "ok", limit: 0 }],
    [{ query: "ok", limit: 21 }],
    [{ query: "ok", limit: 1.5 }],
  ])("rejects %j before any provider call", async (input) => {
    const { deps, embedded } = setup();
    await expect(searchChunks(deps, actor, input)).rejects.toBeInstanceOf(InvalidSearch);
    expect(embedded).toEqual([]);
  });
});
