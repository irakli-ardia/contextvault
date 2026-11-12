import { extractiveAnswerer } from "@contextvault/ai";
import type { Answerer } from "@contextvault/domain/answers";
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

// Grounded answers end to end with offline providers: no model, no network, no cost.
const fx = await createTenantFixture(4);
const refunds = "Refund policy: you can get a refund for annual plans within 30 days of purchase.";
let api: Api;
let token: string;
let otherToken: string;
let wsA: string;
let wsB: string;
let prompts: Parameters<Answerer["answer"]>[0][] = [];
let draft: Awaited<ReturnType<Answerer["answer"]>> | null = null;

// Records what the model would have been given; replays a scripted draft, else answers extractively.
const spy: Answerer = {
  model: "spy",
  answer: async (input) => {
    prompts.push(input);
    return draft ?? extractiveAnswerer.answer(input);
  },
};
const ask = (tok: string | null, ws: string, body: string | object) => {
  const req = api.http.post(`/workspaces/${ws}/answers`).set("Origin", webOrigin).send(body);
  return tok === null ? req : req.set("Cookie", `cv_session=${tok}`);
};
const signIn = async (account: Account) => (await loginAs(api, account)).token;

beforeAll(async () => {
  api = await startApi({}, { answerer: spy });
  const [a, b] = await Promise.all([seedAccount(fx), seedAccount(fx)]);
  wsA = await fx.createWorkspace(a.id, "A");
  wsB = await fx.createWorkspace(b.id, "B");
  [token, otherToken] = await Promise.all([signIn(a), signIn(b)]);
  await seedChunk(fx, { ws: wsA, by: a, name: "refunds.txt", text: refunds });
  await seedChunk(fx, { ws: wsA, by: a, name: "deleted.txt", text: refunds, deleted: true });
  await seedChunk(fx, {
    ws: wsB,
    by: b,
    name: "b-secret.txt",
    text: "Project Nightjar launches in March.",
  });
});
afterAll(async () => {
  await api.app.close();
  await fx.close();
});

describe("POST /workspaces/:workspaceId/answers", () => {
  it("answers with a citation that resolves to the authorized span", async () => {
    draft = null;
    const res = await ask(token, wsA, { question: "When can I get a refund for annual plans?" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: "answer", model: "spy" });
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0]).toMatchObject({
      displayName: "refunds.txt",
      startOffset: 0,
      endOffset: refunds.length,
      excerpt: refunds,
    });
  });

  it("abstains, without calling the model, when no document is related", async () => {
    prompts = [];
    const res = await ask(token, wsA, { question: "zzzz qqqq xxxx" });
    expect(res.body).toEqual({
      kind: "insufficient_evidence",
      model: "spy",
      reason: "no_evidence",
    });
    expect(prompts).toHaveLength(0);
  });

  it("abstains when the model declines or cites nothing it was given", async () => {
    draft = { answerable: true, text: "Made up.", citations: [42] };
    const res = await ask(token, wsA, { question: "refund annual plans" });
    expect(res.body).toMatchObject({ kind: "insufficient_evidence", reason: "not_supported" });
    draft = null;
  });

  it("hands the model only its own workspace's passages, and never deleted ones", async () => {
    prompts = [];
    await ask(token, wsA, { question: "refund annual plans Nightjar March" });
    const sent = JSON.stringify(prompts.map((p) => p.passages));
    expect(sent).not.toContain("Nightjar");
    expect(prompts[0]?.passages).toHaveLength(1);
    const foreign = await ask(otherToken, wsA, { question: "refund" });
    expect(foreign.status).toBe(404);
  });

  it("ignores citation numbers the model was never given", async () => {
    draft = { answerable: true, text: "refunds take 99 days", citations: [1, 2, 3] };
    const res = await ask(otherToken, wsB, { question: "Nightjar launches in March" });
    expect(res.body.kind).toBe("answer");
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0].displayName).toBe("b-secret.txt");
    draft = null;
  });

  it("requires a session and a valid body, and throttles per user", async () => {
    expect((await ask(null, wsA, { question: "refund" })).status).toBe(401);
    for (const body of [{}, { question: 1 }, { question: "x", workspaceId: wsA }, "refund"]) {
      expect((await ask(token, wsA, body)).status).toBe(400);
    }
    expect((await ask(token, wsA, { question: "   " })).status).toBe(400);
    const burst = await Promise.all(
      Array.from({ length: 8 }, () => ask(token, wsA, { question: "refund" })),
    );
    const throttled = burst.find((r) => r.status === 429);
    expect(throttled?.body.error.code).toBe("answer.throttled");
    expect(throttled?.headers["retry-after"]).toMatch(/^\d+$/);
  });
});
