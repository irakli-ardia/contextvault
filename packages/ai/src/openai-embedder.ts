import {
  type DeadlineSignal,
  type Embedder,
  EmbeddingFailure,
  embeddingDimensions,
} from "@contextvault/domain";

export interface OpenAiEmbedderOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Overridable for tests; defaults to the OpenAI API. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

// The API accepts up to 2048 inputs per request; stay far below it to bound request size.
const batchSize = 64;
const timeoutMs = 30_000;

// Calls the embeddings endpoint directly (no SDK). The key is only ever sent as a header; error
// bodies are dropped because they can echo input text.
export function createOpenAiEmbedder(options: OpenAiEmbedderOptions): Embedder {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseUrl ?? "https://api.openai.com/v1"}/embeddings`;

  async function embedBatch(
    input: readonly string[],
    signal: DeadlineSignal | undefined,
  ): Promise<number[][]> {
    // The caller's signal is a DeadlineSignal (domain has no DOM types): bridge it to a controller.
    const cancel = new AbortController();
    const onAbort = (): void => cancel.abort();
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: options.model, input, dimensions: embeddingDimensions }),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel.signal]),
      });
    } catch {
      throw new EmbeddingFailure("embedding.unavailable", true);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (!response.ok) {
      // 429 and 5xx may succeed later; the rest (bad key, bad request) will not.
      throw new EmbeddingFailure(
        "embedding.rejected",
        response.status === 429 || response.status >= 500,
      );
    }
    const body: unknown = await response.json().catch(() => null);
    return parseVectors(body, input.length);
  }

  return {
    model: `openai:${options.model}`,
    async embed(texts, signal) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        out.push(...(await embedBatch(texts.slice(i, i + batchSize), signal)));
      }
      return out;
    },
  };
}

function parseVectors(body: unknown, expected: number): number[][] {
  const data = typeof body === "object" && body !== null && "data" in body ? body.data : null;
  if (!Array.isArray(data) || data.length !== expected) throw malformed();
  const vectors: number[][] = [];
  for (const item of data) {
    const vector: unknown =
      typeof item === "object" && item !== null && "embedding" in item ? item.embedding : null;
    const isVector =
      Array.isArray(vector) &&
      vector.length === embeddingDimensions &&
      vector.every((x) => typeof x === "number" && Number.isFinite(x));
    if (!isVector) throw malformed();
    vectors.push(vector);
  }
  return vectors;
}

const malformed = () => new EmbeddingFailure("embedding.malformed_response", false);
