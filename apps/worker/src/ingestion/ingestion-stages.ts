import { StageFailure, type StageInput, type StageRunner } from "@contextvault/domain";
import { chunkFixedWindow, type ParsedDocument } from "@contextvault/ingestion";
import type { ParsedHandoff } from "./parsed-handoff";

export interface IngestionStagesDeps {
  /** Reads the version's stored bytes under the job's workspace; throws a classified `StageFailure`. */
  readonly readBytes: (input: StageInput) => Promise<Uint8Array>;
  /** Parses in the isolated child; throws `ParseFailure`, or `ParseCancelled` when `signal` fires. */
  readonly parse: (bytes: Uint8Array, signal: StageInput["signal"]) => Promise<ParsedDocument>;
  readonly handoff: ParsedHandoff;
  /** Ids of the sections and chunks a version is activated with. */
  readonly newId: () => string;
}

// Parsing is a pure function of the stored bytes and writes nothing, so a repeated or stale run is
// harmless; the fenced transition after it is what decides whether the result counts. A result is
// handed over only if the lease is still ours. Chunking takes it, exactly once, in the same
// delivery, and returns the chunk set; nothing is written until the fenced activation.
export function createIngestionStages(deps: IngestionStagesDeps): StageRunner {
  return {
    async run(input) {
      const key = { versionId: input.versionId, leaseGeneration: input.leaseGeneration };
      if (input.stage === "parsing") {
        const document = await deps.parse(await deps.readBytes(input), input.signal);
        if (!input.signal.aborted) deps.handoff.put(key, document);
        return undefined;
      }
      const document = deps.handoff.take(key);
      if (!document) throw new StageFailure("handoff.missing", true);
      const chunkSet = chunkFixedWindow(document, deps.newId);
      // The parser rejects text-free documents, so this is a guard, not an expected outcome.
      if (chunkSet.chunks.length === 0) throw new StageFailure("chunk.no_content", false);
      return chunkSet;
    },
  };
}
