import type { DeadlineSignal } from "../documents/ports";
import type { DocumentVersionId, WorkspaceId } from "../kernel/ids";
import type { IngestionFailure, IngestionStage } from "./lifecycle";
import type { IngestionUnitOfWork } from "./ports";
import { type SettleFailureDeps, settleFailure } from "./settle-failure";
import { StageFailure, type StageRunner } from "./stage-runner";

export interface ProcessVersionDeps extends SettleFailureDeps {
  readonly uow: IngestionUnitOfWork;
  readonly stages: StageRunner;
}

export interface ProcessVersionInput {
  readonly workspaceId: WorkspaceId;
  readonly versionId: DocumentVersionId;
  readonly signal: DeadlineSignal;
}

export type ProcessVersionResult =
  | { readonly outcome: "processed" }
  /** Nothing was claimed: not claimable, deleted, attempts spent, or a retry is still scheduled. */
  | { readonly outcome: "refused" }
  | { readonly outcome: "retry"; readonly failure: IngestionFailure; readonly delayMs: number }
  | { readonly outcome: "failed"; readonly failure: IngestionFailure }
  /** Ownership moved on: a fenced write matched nothing, so another claim owns the version. */
  | { readonly outcome: "stale" }
  /** The signal fired. Nothing is written; the lease expires and recovery requeues the version. */
  | { readonly outcome: "aborted" };

const stages: readonly { stage: IngestionStage; next: "chunking" | "processed" }[] = [
  { stage: "parsing", next: "chunking" },
  { stage: "chunking", next: "processed" },
];

const unexpected = { code: "stage.unexpected", retryable: true } as const;

// An unknown exception is retried within the attempt budget: it is more likely a transient fault
// than a verdict on the document. Its message is dropped, as it may carry document content.
const classify = (stage: IngestionStage, error: unknown): IngestionFailure =>
  error instanceof StageFailure
    ? { stage, code: error.code, retryable: error.retryable }
    : { stage, ...unexpected };

type Stopped = Exclude<ProcessVersionResult, { outcome: "processed" | "refused" }>;

interface Claim extends ProcessVersionInput {
  readonly leaseGeneration: number;
}

// Runs one stage and advances past it; a result means the version stopped here.
async function runStage(
  deps: ProcessVersionDeps,
  claim: Claim,
  { stage, next }: (typeof stages)[number],
): Promise<Stopped | null> {
  const { workspaceId, versionId, leaseGeneration, signal } = claim;
  try {
    await deps.stages.run({ stage, workspaceId, versionId, leaseGeneration, signal });
  } catch (error) {
    if (signal.aborted) return { outcome: "aborted" };
    const failure = classify(stage, error);
    const settled = await settleFailure(deps, { workspaceId, versionId, leaseGeneration, failure });
    if (settled.outcome === "retry") {
      return { outcome: "retry", failure, delayMs: settled.delayMs };
    }
    return settled.outcome === "failed" ? { outcome: "failed", failure } : { outcome: "stale" };
  }
  if (signal.aborted) return { outcome: "aborted" };
  const moved = await deps.uow.run({ workspaceId }, ({ ingestion }) =>
    ingestion.transition({ versionId, leaseGeneration, from: stage, to: next }),
  );
  return moved ? null : { outcome: "stale" };
}

/**
 * Claims the version, then runs each stage outside any transaction and advances with a fenced
 * transition. A failure goes through `settleFailure`, so PostgreSQL owns attempts and backoff.
 * Errors from the database (including an unknown commit outcome) propagate: the caller redelivers.
 */
export async function processVersion(
  deps: ProcessVersionDeps,
  input: ProcessVersionInput,
): Promise<ProcessVersionResult> {
  const { workspaceId, versionId, signal } = input;
  if (signal.aborted) return { outcome: "aborted" };

  const claimed = await deps.uow.run({ workspaceId }, ({ ingestion }) =>
    ingestion.claim({ versionId }),
  );
  if (!claimed) return { outcome: "refused" };

  for (const step of stages) {
    const stopped = await runStage(deps, { ...input, ...claimed }, step);
    if (stopped) return stopped;
  }
  return { outcome: "processed" };
}
