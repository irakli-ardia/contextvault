import { randomUUID } from "node:crypto";
import type { ChunkSet } from "@contextvault/domain";

/** One section and one chunk with fresh ids: enough for a stage test double to be activated. */
export function chunkSetFixture(content = "fixture text"): ChunkSet {
  const sectionId = randomUUID();
  return {
    strategyId: "fixed-window",
    strategyVersion: 1,
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
