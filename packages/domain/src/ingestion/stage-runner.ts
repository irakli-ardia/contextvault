import type { DeadlineSignal } from "../documents/ports";
import { DomainError } from "../kernel/errors";
import type { DocumentVersionId, WorkspaceId } from "../kernel/ids";
import type { IngestionStage } from "./lifecycle";

export interface StageInput {
  readonly stage: IngestionStage;
  readonly workspaceId: WorkspaceId;
  readonly versionId: DocumentVersionId;
  /** For the runner to fence its own writes with. */
  readonly leaseGeneration: number;
  /** Aborts on cancellation or lost ownership; the runner must stop and may throw. */
  readonly signal: DeadlineSignal;
}

/**
 * Executes one stage outside any transaction. Resolves when the stage is done; throws a
 * `StageFailure` for a classified failure. Anything else thrown is treated as unexpected.
 */
export interface StageRunner {
  run(input: StageInput): Promise<void>;
}

/** A classified stage failure. The message is the code, so nothing from the document can leak. */
export class StageFailure extends DomainError {
  constructor(
    code: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(code, code, options);
  }
}
