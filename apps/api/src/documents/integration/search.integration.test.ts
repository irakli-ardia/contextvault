import { randomUUID } from "node:crypto";
import { hashEmbedder } from "@contextvault/ai";
import { parseSearchResponse } from "@contextvault/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  type Api,
  createTenantFixture,
  loginAs,
  seedAccount,
  startApi,
  webOrigin,
} from "../../testing/test-support";
import { RetryLimiter } from "../retry-limiter";
import { seedChunk } from "./chunk-seed-test-support";

// Retrieval (vector, keyword, hybrid) end to end with the offline hash embedder (no provider, no cost): the
// worker's activation output is seeded directly, then the HTTP route is asked.
const fx = await createTenantFixture(4);
let api: Api;
let alice: { account: Account; token: string };
let bob: { account: Account; token: string };
let wsA: string;
let wsB: string;
let wsC: string;
const keywordSeeds: Record<string, string> = {};

const signIn = async (account: Account) => ({
  account,
  token: (await loginAs(api, account)).token,
});
const search = (token: string | null, ws: string, body: string | object) => {
  const req = api.http.post(`/workspaces/${ws}/search`).set("Origin", webOrigin).send(body);
  return token === null ? req : req.set("Cookie", `cv_session=${token}`);
};

const refunds = "Refund policy: you can get a refund for annual plans within 30 days of purchase.";
let visible: Awaited<ReturnType<typeof seedChunk>>;

beforeAll(async () => {
  // This file sends far more requests per user than the production allowance; throttling has its own file.
  const searchLimiter = new RetryLimiter(Date.now, "search.throttled", 10_000);
  api = await startApi({}, { searchLimiter });
  const [a, b] = await Promise.all([seedAccount(fx), seedAccount(fx)]);
  wsA = await fx.createWorkspace(a.id, "A");
  wsB = await fx.createWorkspace(b.id, "B");
  wsC = await fx.createWorkspace(a.id, "C");
  [alice, bob] = await Promise.all([signIn(a), signIn(b)]);
  const base = { ws: wsA, by: a };
  visible = await seedChunk(fx, { ...base, name: "refunds.txt", text: refunds });
  await seedChunk(fx, {
    ...base,
    name: "kernel.txt",
    text: "The kernel scheduler assigns threads to processor cores.",
  });
  // Every one of these matches the query best and must still never be returned.
  await seedChunk(fx, { ...base, name: "deleted.txt", text: refunds, deleted: true });
  await seedChunk(fx, { ...base, name: "running.txt", text: refunds, status: "chunking" });
  await seedChunk(fx, { ...base, name: "failed.txt", text: refunds, status: "failed" });
  await seedChunk(fx, { ...base, name: "superseded.txt", text: refunds, inactive: true });
  await seedChunk(fx, { ...base, name: "othermodel.txt", text: refunds, model: "other-model" });
  await seedChunk(fx, { ws: wsB, by: b, name: "b-refunds.txt", text: refunds });
  // Dedicated corpus for keyword semantics (ordering, ties, phrase, OR, negation).
  const corpus: Record<string, string> = {
    "d1.txt": "alpha beta gamma",
    "d2.txt": "beta alpha delta",
    "d3.txt": "alpha alpha alpha epsilon",
    "d4.txt": "alpha alpha alpha epsilon",
    "d5.txt": "zeta",
  };
  for (const [name, text] of Object.entries(corpus)) {
    keywordSeeds[name] = (await seedChunk(fx, { ws: wsC, by: a, name, text })).chunkId;
  }
});
afterAll(async () => {
  await api.app.close();
  await fx.close();
});

describe("POST /workspaces/:workspaceId/search", () => {
  it("returns the closest chunks with document references and similarity, best first", async () => {
    const res = await search(alice.token, wsA, { query: "how do I get a refund?" });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe(hashEmbedder.model);
    const names = res.body.results.map((r: { displayName: string }) => r.displayName);
    expect(names).toEqual(["refunds.txt", "kernel.txt"]);
    expect(res.body.results[0]).toMatchObject({
      chunkId: visible.chunkId,
      documentId: visible.documentId,
      content: refunds,
      startOffset: 0,
      endOffset: refunds.length,
    });
    const [first, second] = res.body.results;
    expect(first.similarity).toBeGreaterThan(second.similarity);
    expect(first.similarity).toBeLessThanOrEqual(1);
  });

  it("defaults to vector mode and keeps the M2.1 fields next to the new ones", async () => {
    const res = await search(alice.token, wsA, { query: "refund" });
    expect(parseSearchResponse(res.body)?.mode).toBe("vector");
    const [first] = res.body.results;
    expect(first.similarity).toBe(first.scores.vector);
    expect(first).toMatchObject({ scores: { keyword: null }, ranks: { vector: 1, keyword: null } });
  });

  // Same isolation matrix per mode. Keyword ignores the embedding model, so the other-model
  // document (an active, ready version) is a legitimate keyword hit but never a vector one.
  describe.each([
    ["vector", refunds, ["kernel.txt", "refunds.txt"]],
    ["keyword", "refund", ["othermodel.txt", "refunds.txt"]],
    // Union of both signals' authorized candidates; nothing outside either list can appear.
    ["hybrid", "refund", ["kernel.txt", "othermodel.txt", "refunds.txt"]],
  ] as const)("%s mode", (mode, query, expected) => {
    const names = (res: { body: { results: { displayName: string }[] } }) =>
      res.body.results.map((r) => r.displayName).sort();

    it("never returns deleted, unfinished, failed, superseded or foreign chunks", async () => {
      const res = await search(alice.token, wsA, { query, mode, limit: 20 });
      expect(res.status).toBe(200);
      expect(parseSearchResponse(res.body)?.mode).toBe(mode);
      expect(names(res)).toEqual([...expected]);
      expect(res.text).not.toContain("b-refunds");
    });

    it("keeps workspaces apart: each member sees only their own, and a foreign path is a 404", async () => {
      const own = await search(bob.token, wsB, { query: "refund", mode });
      expect(names(own)).toEqual(["b-refunds.txt"]);
      const foreign = await search(bob.token, wsA, { query: "refund", mode });
      expect(foreign.status).toBe(404);
      expect(foreign.text).not.toContain("refunds.txt");
    });

    it("requires a session", async () => {
      expect((await search(null, wsA, { query: "refund", mode })).status).toBe(401);
    });
  });

  it("keyword mode returns the matching chunk with a keyword score and no vector signal", async () => {
    const res = await search(alice.token, wsA, { query: "kernel scheduler", mode: "keyword" });
    expect(parseSearchResponse(res.body)).not.toBeNull();
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({
      displayName: "kernel.txt",
      similarity: null,
      scores: { vector: null },
      ranks: { vector: null, keyword: 1 },
    });
    expect(res.body.results[0].scores.keyword).toBeGreaterThan(0);
  });

  interface KeywordRow {
    displayName: string;
    chunkId: string;
    scores: { keyword: number };
  }

  describe("keyword semantics", () => {
    // uuids compare bytewise in PostgreSQL; plain string order on lowercase hex is the same.
    const tieIds = () =>
      [keywordSeeds["d3.txt"], keywordSeeds["d4.txt"]].sort((x, y) =>
        (x ?? "") < (y ?? "") ? -1 : 1,
      );
    const run = async (query: string, limit?: number) => {
      const res = await search(alice.token, wsC, { query, mode: "keyword", limit });
      expect(res.status).toBe(200);
      const rows: KeywordRow[] = res.body.results;
      return rows;
    };
    const names = (rows: { displayName: string }[]) => rows.map((r) => r.displayName);

    it("orders by score, then chunk id, and ranks by position", async () => {
      const rows = await run("alpha");
      expect(rows).toHaveLength(4);
      const [first, second] = rows;
      expect([first?.chunkId, second?.chunkId]).toEqual(tieIds());
      expect(first?.scores.keyword).toBe(second?.scores.keyword);
      expect(first?.scores.keyword).toBeGreaterThan(rows[2]?.scores.keyword ?? 0);
      expect(await run("alpha")).toEqual(rows);
    });

    it("applies the limit after ordering", async () => {
      const rows = await run("alpha", 1);
      expect(rows.map((r) => r.chunkId)).toEqual([tieIds()[0]]);
    });

    it("supports phrase, OR and mixed negation", async () => {
      expect(names(await run('"alpha beta"'))).toEqual(["d1.txt"]);
      expect(names(await run("gamma or delta")).sort()).toEqual(["d1.txt", "d2.txt"]);
      expect(names(await run("alpha -gamma")).sort()).toEqual(["d2.txt", "d3.txt", "d4.txt"]);
    });

    it.each(["-gamma", "-gamma -delta", "-alpha -zeta"])(
      "a purely negative query %j returns nothing, not every other chunk",
      async (query) => {
        expect(await run(query)).toEqual([]);
      },
    );

    it("a keyword hit never carries a zero score", async () => {
      for (const query of ["alpha", "gamma or delta", "alpha -gamma"]) {
        for (const row of await run(query)) expect(row.scores.keyword).toBeGreaterThan(0);
      }
    });
  });

  it("keyword mode requires every term, so a question-form query finds nothing (known limit)", async () => {
    const res = await search(alice.token, wsA, {
      query: "how do I get a refund?",
      mode: "keyword",
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it.each(["???", '"', "-", "a & | ! ( b"])("keyword query %j is not an error", async (query) => {
    const res = await search(alice.token, wsA, { query, mode: "keyword" });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it.each([
    [{ query: "   " }],
    [{ query: "x".repeat(1_001) }],
    [{ query: "ok", limit: 21 }],
    [{ query: "ok", limit: 0 }],
    [{ query: "ok", mode: "bogus" }],
    [{ query: "ok", mode: "HYBRID" }],
    [{ query: "   ", mode: "hybrid" }],
    [{ query: "ok", mode: null }],
    [{ query: "ok", mode: "KEYWORD" }],
    [{ query: "   ", mode: "keyword" }],
    [{ query: "ok", workspaceId: randomUUID() }],
    [{}],
    ["refund"],
  ])("rejects %j as a 400", async (body) => {
    const res = await search(alice.token, wsA, body);
    expect(res.status).toBe(400);
  });
});
