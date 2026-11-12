import type { Embedder } from "@contextvault/domain";
import { hashEmbedder } from "./hash-embedder";
import { createOpenAiEmbedder } from "./openai-embedder";

export { hashEmbed, hashEmbedder } from "./hash-embedder";
export { createOpenAiEmbedder, type OpenAiEmbedderOptions } from "./openai-embedder";

/** Chosen by configuration; `openai` is the only one that costs money. */
export function createEmbedder(config: {
  readonly provider: "openai" | "hash";
  readonly openaiApiKey?: string | undefined;
  readonly openaiModel: string;
}): Embedder {
  if (config.provider === "hash") return hashEmbedder;
  if (config.openaiApiKey === undefined) throw new Error("OPENAI_API_KEY is required for openai");
  return createOpenAiEmbedder({ apiKey: config.openaiApiKey, model: config.openaiModel });
}
