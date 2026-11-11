import { StageFailure, type StageInput, type StageRunner } from "@contextvault/domain";
import type { ParsedDocument } from "@contextvault/ingestion";
import type { ParsedHandoff } from "./parsed-handoff";

export interface IngestionStagesDeps {
  /** Reads the version's stored bytes under the job's workspace; throws a classified `StageFailure`. */
  readonly readBytes: (input: StageInput) => Promise<Uint8Array>;
  /** Parses in the isolated child; throws `ParseFailure`, or `ParseCancelled` when `signal` fires. */
  readonly parse: (bytes: Uint8Array, signal: StageInput["signal"]) => Promise<ParsedDocument>;
  readonly handoff: ParsedHandoff;
}

// Parsing is a pure function of the stored bytes and writes nothing, so a repeated or stale run is
// harmless; the fenced transition after it is what decides whether the result counts. A result is
// handed over only if the lease is still ours. Chunking is M1.6: until then this stage takes the
// result and drops it, which keeps the hand-off contract exercised and the map empty.
export function createIngestionStages(deps: IngestionStagesDeps): StageRunner {
  return {
    async run(input) {
      const key = { versionId: input.versionId, leaseGeneration: input.leaseGeneration };
      if (input.stage === "parsing") {
        const document = await deps.parse(await deps.readBytes(input), input.signal);
        if (!input.signal.aborted) deps.handoff.put(key, document);
        return;
      }
      if (!deps.handoff.take(key)) throw new StageFailure("handoff.missing", true);
    },
  };
}
