import type { Embedder } from "@contextvault/domain";
import type { Answerer } from "@contextvault/domain/answers";
import { extractiveAnswerer } from "./extractive-answerer";
import { hashEmbedder } from "./hash-embedder";
import { createOpenAiAnswerer } from "./openai-answerer";
import { createOpenAiEmbedder } from "./openai-embedder";

export { extractiveAnswerer } from "./extractive-answerer";
export { hashEmbed, hashEmbedder } from "./hash-embedder";
export { createOpenAiAnswerer, type OpenAiAnswererOptions } from "./openai-answerer";
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

/** Chosen by configuration; `openai` is the only one that costs money. */
export function createAnswerer(config: {
  readonly provider: "openai" | "extractive";
  readonly openaiApiKey?: string | undefined;
  readonly openaiModel: string;
}): Answerer {
  if (config.provider === "extractive") return extractiveAnswerer;
  if (config.openaiApiKey === undefined) throw new Error("OPENAI_API_KEY is required for openai");
  return createOpenAiAnswerer({ apiKey: config.openaiApiKey, model: config.openaiModel });
}
