import { randomUUID } from "node:crypto";
import type { EmbeddedChunkSet } from "@contextvault/domain";

/** One section and one chunk with fresh ids: enough for a stage test double to be activated. */
export function chunkSetFixture(content = "fixture text"): EmbeddedChunkSet {
  const sectionId = randomUUID();
  return {
    strategyId: "fixed-window",
    strategyVersion: 1,
    embeddingModel: "test",
    embeddings: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
    sections: [
      { id: sectionId, ordinal: 0, page: null, startOffset: 0, endOffset: content.length },
    ],
    chunks: [
      {
        id: randomUUID(),
        sectionId,
        ordinal: 0,
        content,
        contentSha256: new Uint8Array(32),
        tokenCount: 1,
        startOffset: 0,
        endOffset: content.length,
      },
    ],
  };
}
