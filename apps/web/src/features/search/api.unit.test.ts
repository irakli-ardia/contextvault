import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../lib/http-client";
import { searchModes, searchWorkspace } from "./api";

const result = {
  chunkId: "c1",
  documentId: "d1",
  displayName: "a.txt",
  content: "text",
  startOffset: 0,
  endOffset: 4,
  similarity: null,
  scores: { vector: null, keyword: 0.5, fused: null },
  ranks: { vector: null, keyword: 1 },
};

const sentJson = (init?: RequestInit): unknown =>
  typeof init?.body === "string" ? JSON.parse(init.body) : null;

afterEach(() => vi.unstubAllGlobals());

describe("search DAL", () => {
  it("posts the query and mode to an encoded path and validates the body", async () => {
    const fn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ model: "hash-v1", mode: "keyword", results: [result] }),
    );
    vi.stubGlobal("fetch", fn);
    const response = await searchWorkspace("w/../x", "q", "keyword");
    expect(response.results).toHaveLength(1);
    expect(fn.mock.calls[0]?.[0]).toBe("/api/workspaces/w%2F..%2Fx/search");
    expect(sentJson(fn.mock.calls[0]?.[1])).toEqual({
      query: "q",
      mode: "keyword",
    });
  });

  it("rejects a body the contract refuses", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ model: "m", mode: "vector", results: 1 }));
    await expect(searchWorkspace("w1", "q", "vector")).rejects.toMatchObject({
      code: "response.invalid",
    });
  });

  it("keeps one mode's failure from hiding the others", async () => {
    vi.stubGlobal("fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      return JSON.stringify(sentJson(init)).includes('"vector"')
        ? Response.json(
            { error: { code: "search.throttled", requestId: "r" } },
            { status: 429, headers: { "retry-after": "9" } },
          )
        : Response.json({ model: "hash-v1", mode: "keyword", results: [] });
    });
    const outcomes = await searchModes("w1", "q", ["vector", "keyword"]);
    const [first, second] = outcomes;
    expect(first?.ok).toBe(false);
    expect(first && !first.ok && first.error).toBeInstanceOf(HttpError);
    expect(first && !first.ok && first.error).toMatchObject({ status: 429, retryAfterSeconds: 9 });
    expect(second?.ok).toBe(true);
  });
});
