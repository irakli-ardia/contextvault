import { hashEmbedder } from "@contextvault/ai";
import type { Embedder } from "@contextvault/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Api,
  createTenantFixture,
  loginAs,
  seedAccount,
  startApi,
  webOrigin,
} from "../../testing/test-support";
import { MAX_SEARCHES_PER_USER } from "../retry-limiter";

// Production wiring: the default limiter, offline providers (hash embedder), no seeded data needed.
const fx = await createTenantFixture(3);
let api: Api;
let ws: string;
let embeds = 0;
// The offline hash embedder behind a counter: proves which requests reach the embedder.
const embedder: Embedder = {
  model: hashEmbedder.model,
  embed: async (texts) => {
    embeds += 1;
    return hashEmbedder.embed(texts);
  },
};

const search = (token: string, body: object | string) =>
  api.http
    .post(`/workspaces/${ws}/search`)
    .set("Origin", webOrigin)
    .set("Cookie", `cv_session=${token}`)
    .send(body);

beforeAll(async () => {
  api = await startApi({}, { embedder });
  ws = await fx.createWorkspace((await seedAccount(fx)).id, "T");
});
afterAll(async () => {
  await api.app.close();
  await fx.close();
});

describe("search rate limit", () => {
  it.each(["vector", "keyword", "hybrid"] as const)(
    "allows the allowance, then 429 with Retry-After (%s)",
    async (mode) => {
      const user = await extraUser();
      for (let n = 0; n < MAX_SEARCHES_PER_USER; n++) {
        expect((await search(user.token, { query: "refund", mode })).status).toBe(200);
      }
      const res = await search(user.token, { query: "refund", mode });
      expect([res.status, res.body.error.code]).toEqual([429, "search.throttled"]);
      expect(res.headers["retry-after"]).toMatch(/^[1-9]\d*$/);
      expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(60);
    },
  );

  it("is per user: a throttled user does not block another member", async () => {
    const busy = await extraUser();
    for (let n = 0; n < MAX_SEARCHES_PER_USER; n++) await search(busy.token, { query: "refund" });
    expect((await search(busy.token, { query: "refund" })).status).toBe(429);
    const other = await extraUser();
    expect((await search(other.token, { query: "refund" })).status).toBe(200);
  });

  it.each([
    ["an unknown key", { query: "x", workspaceId: "w" }],
    ["a blank query", { query: "   " }],
    ["an empty query", { query: "" }],
    ["an overlong query", { query: "x".repeat(1_001) }],
    ["limit 0", { query: "x", limit: 0 }],
    ["limit 21", { query: "x", limit: 21 }],
    ["a fractional limit", { query: "x", limit: 1.5 }],
    ["an unknown mode", { query: "x", mode: "bogus" }],
    ["a non-object body", "refund"],
  ])("does not count %s, and valid requests still do", async (_name, invalid) => {
    const user = await extraUser();
    const before = embeds;
    for (let n = 0; n < MAX_SEARCHES_PER_USER + 5; n++) {
      expect((await search(user.token, invalid)).status).toBe(400);
    }
    expect(embeds).toBe(before);
    // The whole allowance is still there: exactly MAX valid requests pass, the next is refused.
    for (let n = 0; n < MAX_SEARCHES_PER_USER; n++) {
      expect((await search(user.token, { query: "refund", mode: "hybrid" })).status).toBe(200);
    }
    expect((await search(user.token, { query: "refund", mode: "hybrid" })).status).toBe(429);
  });

  it("a trimmed query at the length limit is valid and counts", async () => {
    const user = await extraUser();
    expect((await search(user.token, { query: ` ${"x".repeat(1_000)} `, limit: 20 })).status).toBe(
      200,
    );
  });

  it("a throttled request never reaches the embedder", async () => {
    const user = await extraUser();
    const before = embeds;
    for (let n = 0; n < MAX_SEARCHES_PER_USER; n++) {
      await search(user.token, { query: "refund", mode: n % 2 === 0 ? "vector" : "hybrid" });
    }
    expect(embeds).toBe(before + MAX_SEARCHES_PER_USER);
    for (const mode of ["vector", "hybrid"]) {
      expect((await search(user.token, { query: "refund", mode })).status).toBe(429);
    }
    expect(embeds).toBe(before + MAX_SEARCHES_PER_USER);
  });
});

async function extraUser() {
  const account = await seedAccount(fx);
  await fx.fixture.query(
    "insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member')",
    [ws, account.id],
  );
  return loginAs(api, account);
}
