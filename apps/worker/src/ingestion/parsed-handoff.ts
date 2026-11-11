import type { DocumentVersionId } from "@contextvault/domain";
import type { ParsedDocument } from "@contextvault/ingestion";

export interface HandoffKey {
  readonly versionId: DocumentVersionId;
  /** The claim that produced the result: a newer claim never receives an older claim's document. */
  readonly leaseGeneration: number;
}

/**
 * How a `ParsedDocument` crosses from the parsing stage to the chunking stage (ADR 0011). Every
 * claim runs both stages in one delivery of one process, so memory is enough: nothing is
 * persisted, no second copy of the text exists elsewhere, and a restart simply re-parses.
 * One entry per version, taken exactly once; a bound on entries drops the oldest, which only costs
 * a retryable `handoff.missing` for a delivery that was cancelled between the stages.
 */
export interface ParsedHandoff {
  put(key: HandoffKey, document: ParsedDocument): void;
  /** Removes and returns the document, only when the generation matches. */
  take(key: HandoffKey): ParsedDocument | undefined;
}

export function createParsedHandoff(maxEntries = 16): ParsedHandoff {
  const entries = new Map<string, { leaseGeneration: number; document: ParsedDocument }>();
  return {
    put({ versionId, leaseGeneration }, document) {
      entries.delete(versionId);
      entries.set(versionId, { leaseGeneration, document });
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) break;
        entries.delete(oldest);
      }
    },
    take({ versionId, leaseGeneration }) {
      const entry = entries.get(versionId);
      if (entry?.leaseGeneration !== leaseGeneration) return undefined;
      entries.delete(versionId);
      return entry.document;
    },
  };
}
