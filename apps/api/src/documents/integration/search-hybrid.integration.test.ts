import { hashEmbedder } from "@contextvault/ai";
import { parseSearchResponse } from "@contextvault/contracts";
import { type Embedder, EmbeddingFailure } from "@contextvault/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Api,
  createTenantFixture,
  loginAs,
  seedAccount,
  startApi,
  webOrigin,
} from "../../testing/test-support";
import { RetryLimiter } from "../retry-limiter";
import { seedChunk } from "./chunk-seed-test-support";

// Hybrid fusion end to end. The embedder is the offline hash embedder behind a counter, so no
// provider is reachable; chunks are seeded with explicit embeddings so the signals can disagree.
const fx = await createTenantFixture(3);
let api: Api;
let token: string;
let wsFused: string;
let wsLegacy: string;
let wsZero: string;
let embeds = 0;
let failing = false;
const embedder: Embedder = {
  model: hashEmbedder.model,
  embed: async (texts) => {
    embeds += 1;
    if (failing) throw new EmbeddingFailure("embedding.unavailable", true);
    return hashEmbedder.embed(texts);
  },
};
const hybrid = (ws: string, body: object, tok: string | null = token) => {
  const req = api.http
    .post(`/workspaces/${ws}/search`)
    .set("Origin", webOrigin)
    .send({ mode: "hybrid", ...body });
  return tok === null ? req : req.set("Cookie", `cv_session=${tok}`);
};
const names = (res: { body: { results: { displayName: string }[] } }) =>
  res.body.results.map((r) => r.displayName);

beforeAll(async () => {
  const searchLimiter = new RetryLimiter(Date.now, "search.throttled", 10_000);
  api = await startApi({}, { embedder, searchLimiter });
  const account = await seedAccount(fx);
  wsFused = await fx.createWorkspace(account.id, "fused");
  wsLegacy = await fx.createWorkspace(account.id, "legacy");
  wsZero = await fx.createWorkspace(account.id, "zero");
  token = (await loginAs(api, account)).token;
  const base = { ws: wsFused, by: account };
  // Query "zebra". Vector order: both, vectoronly, keywordonly. Keyword order: both, keywordonly.
  await seedChunk(fx, { ...base, name: "both.txt", text: "zebra zebra zebra", embedAs: "zebra" });
  await seedChunk(fx, {
    ...base,
    name: "vectoronly.txt",
    text: "unrelated paragraph",
    embedAs: "zebra stripes",
  });
  await seedChunk(fx, {
    ...base,
    name: "keywordonly.txt",
    text: "zebra crossing",
    embedAs: "qq xx",
  });
  // Two valid vectors and one zero-norm vector (hashEmbed("???") has no direction): its cosine
  // distance is NaN.
  const zero = { ws: wsZero, by: account };
  await seedChunk(fx, { ...zero, name: "z-near.txt", text: "zebra", embedAs: "zebra" });
  await seedChunk(fx, { ...zero, name: "z-far.txt", text: "stripes", embedAs: "zebra stripes" });
  await seedChunk(fx, { ...zero, name: "z-zero.txt", text: "zebra zero", embedAs: "???" });
  // Chunks embedded with another model: only the keyword signal exists for them.
  const legacy = { ws: wsLegacy, by: account, model: "legacy-model" };
  await seedChunk(fx, { ...legacy, name: "l1.txt", text: "zebra zebra stripes" });
  await seedChunk(fx, { ...legacy, name: "l2.txt", text: "zebra crossing" });
});
afterAll(async () => {
  await api.app.close();
  await fx.close();
});

describe("hybrid mode", () => {
  it("fuses the two signals with RRF, so the fused order differs from the vector order", async () => {
    const vector = await hybrid(wsFused, { query: "zebra", mode: "vector" });
    expect(names(vector)).toEqual(["both.txt", "vectoronly.txt", "keywordonly.txt"]);
    const res = await hybrid(wsFused, { query: "zebra" });
    expect(res.status).toBe(200);
    expect(parseSearchResponse(res.body)?.mode).toBe("hybrid");
    // keywordonly has vector rank 3 + keyword rank 2 and beats vectoronly's single rank 2.
    expect(names(res)).toEqual(["both.txt", "keywordonly.txt", "vectoronly.txt"]);
    const [both, keywordOnly, vectorOnly] = res.body.results;
    expect(both).toMatchObject({ ranks: { vector: 1, keyword: 1 } });
    expect(both.scores.fused).toBe(1 / 61 + 1 / 61);
    expect(keywordOnly).toMatchObject({ ranks: { vector: 3, keyword: 2 } });
    expect(keywordOnly.scores.fused).toBe(1 / 63 + 1 / 62);
    expect(vectorOnly).toMatchObject({
      ranks: { vector: 2, keyword: null },
      scores: { keyword: null, fused: 1 / 62 },
    });
    expect(vectorOnly.similarity).toBe(vectorOnly.scores.vector);
    expect(both.scores.keyword).toBeGreaterThan(keywordOnly.scores.keyword);
  });

  it("is deterministic and applies the limit after fusion", async () => {
    const first = await hybrid(wsFused, { query: "zebra" });
    expect((await hybrid(wsFused, { query: "zebra" })).body).toEqual(first.body);
    const one = await hybrid(wsFused, { query: "zebra", limit: 1 });
    expect(names(one)).toEqual(["both.txt"]);
    expect(one.body.results[0].scores.fused).toBe(first.body.results[0].scores.fused);
  });

  it("without vectors of the embedding model, orders exactly like keyword mode", async () => {
    const keyword = await hybrid(wsLegacy, { query: "zebra", mode: "keyword" });
    const res = await hybrid(wsLegacy, { query: "zebra" });
    expect(parseSearchResponse(res.body)).not.toBeNull();
    expect(names(res)).toEqual(names(keyword));
    expect(names(res)).toHaveLength(2);
    res.body.results.forEach(
      (r: { scores: { vector: null; fused: number }; ranks: { vector: null } }, i: number) => {
        expect([r.scores.vector, r.ranks.vector, r.scores.fused]).toEqual([
          null,
          null,
          1 / (61 + i),
        ]);
      },
    );
  });

  it.each(["vector", "hybrid"] as const)(
    "a query with no tokens has no direction, so %s mode returns no hits",
    async (mode) => {
      // The hash embedder maps it to the zero vector; cosine is NaN and must not become a hit.
      for (const ws of [wsFused, wsLegacy]) {
        const res = await hybrid(ws, { query: "???", mode });
        expect([res.status, res.body.results]).toEqual([200, []]);
      }
    },
  );

  it("pgvector yields NaN for a zero vector and PostgreSQL sorts NaN after every number", async () => {
    const [nan] = await fx.queryAs<{ d: number; sorted: number[] }>(
      null,
      `select '[1,0,0]'::vector <=> '[0,0,0]'::vector as d,
              (select array_agg(x order by x) from (values ('NaN'::float8), (0.5), (-1), (1)) v(x)) as sorted`,
    );
    expect(Number.isNaN(nan?.d)).toBe(true);
    expect(nan?.sorted.slice(0, 3)).toEqual([-1, 0.5, 1]);
    expect(Number.isNaN(nan?.sorted[3])).toBe(true);
  });

  it("a stored zero-norm vector never becomes a scored hit nor displaces a valid one", async () => {
    // limit 2 with three candidates: were NaN ordered first, a valid chunk would be cut.
    const vector = await hybrid(wsZero, { query: "zebra", mode: "vector", limit: 2 });
    expect(names(vector)).toEqual(["z-near.txt", "z-far.txt"]);
    for (const r of vector.body.results) {
      expect(Number.isFinite(r.scores.vector) && Number.isFinite(r.similarity)).toBe(true);
    }
    expect(parseSearchResponse(vector.body)).not.toBeNull();
    // Hybrid: the zero-norm chunk can still be found by its text, with no vector signal.
    const res = await hybrid(wsZero, { query: "zebra", limit: 20 });
    expect(parseSearchResponse(res.body)).not.toBeNull();
    const zero = res.body.results.find(
      (r: { displayName: string }) => r.displayName === "z-zero.txt",
    );
    expect(zero).toMatchObject({
      similarity: null,
      scores: { vector: null },
      ranks: { vector: null },
    });
    expect(zero.scores.keyword).toBeGreaterThan(0);
    for (const r of res.body.results) expect(Number.isFinite(r.scores.fused)).toBe(true);
  });

  it("transactions run at the server default, READ COMMITTED, so the two queries may differ", async () => {
    const [row] = await fx.queryAs<{ level: string }>(
      { userId: "00000000-0000-4000-8000-000000000001" },
      "select current_setting('transaction_isolation') as level",
    );
    expect(row?.level).toBe("read committed");
  });

  it("embeds once per hybrid request and keyword mode never embeds", async () => {
    const before = embeds;
    await hybrid(wsFused, { query: "zebra" });
    expect(embeds).toBe(before + 1);
    await hybrid(wsFused, { query: "zebra", mode: "keyword" });
    expect(embeds).toBe(before + 1);
  });

  it("an embedder failure is a 503 with no results and no leaked detail", async () => {
    failing = true;
    try {
      const res = await hybrid(wsFused, { query: "zebra" });
      expect([res.status, res.body.error.code]).toEqual([503, "embedding.unavailable"]);
      expect(res.text).not.toContain("both.txt");
    } finally {
      failing = false;
    }
  });
});
