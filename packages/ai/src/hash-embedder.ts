import { createHash } from "node:crypto";
import { type Embedder, embeddingDimensions } from "@contextvault/domain";

// Offline, free and deterministic: lowercase word unigrams and bigrams are hashed into buckets and
// the vector is L2-normalised, so cosine similarity measures shared vocabulary. It is lexical, not
// semantic (no synonyms); it exists for tests, local development and a zero-cost demo.
// Changing the tokenizer or hash changes every vector, so it must change `model`.
const hashBucket = (feature: string): { index: number; sign: 1 | -1 } => {
  const digest = createHash("sha256").update(feature).digest();
  return {
    index: digest.readUInt32BE(0) % embeddingDimensions,
    sign: (digest[4] ?? 0) % 2 ? 1 : -1,
  };
};

export function hashEmbed(text: string): number[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const vector = new Array<number>(embeddingDimensions).fill(0);
  const add = (feature: string, weight: number): void => {
    const { index, sign } = hashBucket(feature);
    vector[index] = (vector[index] ?? 0) + sign * weight;
  };
  words.forEach((word, i) => {
    add(word, 1);
    const next = words[i + 1];
    if (next !== undefined) add(`${word} ${next}`, 0.5);
  });
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

export const hashEmbedder: Embedder = {
  model: "hash-v1",
  embed: (texts) => Promise.resolve(texts.map(hashEmbed)),
};
