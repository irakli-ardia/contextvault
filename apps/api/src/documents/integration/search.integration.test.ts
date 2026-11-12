import { randomUUID } from "node:crypto";
import { hashEmbedder } from "@contextvault/ai";
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
import { seedChunk } from "./chunk-seed-test-support";

// Semantic retrieval end to end with the offline hash embedder (no provider, no cost): the
// worker's activation output is seeded directly, then the HTTP route is asked.
const fx = await createTenantFixture(4);
let api: Api;
let alice: { account: Account; token: string };
let bob: { account: Account; token: string };
let wsA: string;
let wsB: string;

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
  api = await startApi();
  const [a, b] = await Promise.all([seedAccount(fx), seedAccount(fx)]);
  wsA = await fx.createWorkspace(a.id, "A");
  wsB = await fx.createWorkspace(b.id, "B");
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

  it("never returns deleted, unfinished, failed, superseded, other-model or foreign chunks", async () => {
    const res = await search(alice.token, wsA, { query: refunds, limit: 20 });
    expect(res.body.results.map((r: { displayName: string }) => r.displayName).sort()).toEqual([
      "kernel.txt",
      "refunds.txt",
    ]);
    expect(res.text).not.toContain("b-refunds");
  });

  it("keeps workspaces apart: each member sees only their own, and a foreign path is a 404", async () => {
    const own = await search(bob.token, wsB, { query: "refund" });
    expect(own.body.results.map((r: { displayName: string }) => r.displayName)).toEqual([
      "b-refunds.txt",
    ]);
    const foreign = await search(bob.token, wsA, { query: "refund" });
    expect(foreign.status).toBe(404);
    expect(foreign.text).not.toContain("refunds.txt");
  });

  it("requires a session", async () => {
    expect((await search(null, wsA, { query: "refund" })).status).toBe(401);
  });

  it.each([
    [{ query: "   " }],
    [{ query: "x".repeat(1_001) }],
    [{ query: "ok", limit: 21 }],
    [{ query: "ok", limit: 0 }],
    [{ query: "ok", workspaceId: randomUUID() }],
    [{}],
    ["refund"],
  ])("rejects %j as a 400", async (body) => {
    const res = await search(alice.token, wsA, body);
    expect(res.status).toBe(400);
  });
});
