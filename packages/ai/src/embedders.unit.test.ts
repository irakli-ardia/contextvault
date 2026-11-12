import { EmbeddingFailure, embeddingDimensions } from "@contextvault/domain";
import { describe, expect, it } from "vitest";
import { hashEmbed } from "./hash-embedder";
import { createOpenAiEmbedder } from "./openai-embedder";

const cosine = (a: readonly number[], b: readonly number[]) =>
  a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

describe("hash embedder", () => {
  it("is deterministic, unit length and of the column's dimension", () => {
    const v = hashEmbed("Refund policy for annual plans");
    expect(v).toHaveLength(embeddingDimensions);
    expect(hashEmbed("Refund policy for annual plans")).toEqual(v);
    expect(cosine(v, v)).toBeCloseTo(1, 6);
  });

  it("ranks shared vocabulary above unrelated text", () => {
    const query = hashEmbed("how do I get a refund");
    const related = hashEmbed("Refunds: you can get a refund within 30 days");
    const unrelated = hashEmbed("The kernel schedules threads across cores");
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });

  it("returns a zero vector, not NaN, for text without words", () => {
    expect(hashEmbed("  ...  ").every((x) => x === 0)).toBe(true);
  });
});

const vector = Array.from({ length: embeddingDimensions }, () => 0.5);
const okFetch =
  (calls: Request[] = []): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const sent: { input: string[] } = JSON.parse(await request.clone().text());
    return Response.json({ data: sent.input.map(() => ({ embedding: vector })) });
  };

describe("openai embedder", () => {
  it("batches inputs and sends the key only as a header", async () => {
    const calls: Request[] = [];
    const embedder = createOpenAiEmbedder({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      fetch: okFetch(calls),
    });
    const out = await embedder.embed(Array.from({ length: 130 }, (_, i) => `text ${i}`));
    expect(out).toHaveLength(130);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk-test");
    expect(embedder.model).toBe("openai:text-embedding-3-small");
  });

  it.each([
    [429, true],
    [503, true],
    [401, false],
    [400, false],
  ])("classifies HTTP %i as retryable=%s", async (status, retryable) => {
    const embedder = createOpenAiEmbedder({
      apiKey: "k",
      model: "m",
      fetch: async () => new Response("secret echo of input", { status }),
    });
    const error = await embedder.embed(["x"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingFailure);
    expect(error).toMatchObject({ retryable });
    expect(String(error)).not.toContain("secret");
  });

  it("treats a network failure as retryable and a malformed body as final", async () => {
    const down = createOpenAiEmbedder({
      apiKey: "k",
      model: "m",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(down.embed(["x"])).rejects.toMatchObject({ retryable: true });
    const bad = createOpenAiEmbedder({
      apiKey: "k",
      model: "m",
      fetch: async () => Response.json({ data: [{ embedding: [1, 2] }] }),
    });
    await expect(bad.embed(["x"])).rejects.toMatchObject({
      code: "embedding.malformed_response",
      retryable: false,
    });
  });
});
