import { type ChunkSet, type EmbeddedChunkSet, embeddingDimensions } from "@contextvault/domain";

/** A unit vector along axis `i`: chunk `i` is closest to itself and orthogonal to the others. */
const axisVector = (i: number): number[] =>
  Array.from({ length: embeddingDimensions }, (_, k) => (k === i % embeddingDimensions ? 1 : 0));

/** The chunk set with one deterministic vector per chunk (axis = ordinal). */
export const withAxisEmbeddings = (set: ChunkSet, model = "test-model"): EmbeddedChunkSet => ({
  ...set,
  embeddingModel: model,
  embeddings: set.chunks.map((chunk) => axisVector(chunk.ordinal)),
});
