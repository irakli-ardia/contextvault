import {
  type DeadlineSignal,
  type IngestionUnitOfWork,
  type ProcessVersionDeps,
  type ProcessVersionResult,
  processVersion,
  TransactionOutcomeUnknown,
} from "@contextvault/domain";
import { DelayedError, UnrecoverableError } from "bullmq";
import { errorCause } from "./error-cause";
import { parseIngestionPayload } from "./ingestion-job";
import { isTransientDbError } from "./transient-db-error";

/** The part of a BullMQ job the handler uses. */
export interface IngestionJob {
  readonly name: string;
  readonly data: unknown;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

export interface IngestionHandlerDeps extends ProcessVersionDeps {
  readonly log: (entry: Record<string, unknown>) => void;
  /** Wait before a job that never reached a claim is delivered again. */
  readonly redeliveryDelayMs: number;
  /** Aborts on shutdown or lost ownership; 5A.4 supplies one per job. */
  readonly signal: DeadlineSignal;
  readonly processJobName: string;
}

/** Fails the job with a stable code. BullMQ stores the message, so it is never an error's own. */
export class IngestionJobFailed extends UnrecoverableError {
  constructor(readonly code: string) {
    super(code);
    this.name = "IngestionJobFailed";
  }
}

// Redelivery never retries a version: it only re-offers a job that did nothing. Attempts, leases
// and backoff stay in PostgreSQL, so this adds no counter of its own.
// A delivery ends one of three ways: it returns (the job is done, whatever the version's fate,
// because PostgreSQL holds that), it throws DelayedError (nothing was claimed, a database fault
// is transient), or it throws IngestionJobFailed (nothing safe to repeat from here).
export async function handleIngestionJob(
  deps: IngestionHandlerDeps,
  job: IngestionJob,
  token?: string,
): Promise<void> {
  const payload = job.name === deps.processJobName ? parseIngestionPayload(job.data) : null;
  if (!payload) return reject(deps, "job.invalid_payload");

  // processVersion's first transaction is the claim. Tracking when it resolves is what separates
  // a failure that rolled back before any claim from one that came after.
  let claimResolved = false;
  const uow: IngestionUnitOfWork = {
    run: async (context, work, options) => {
      const first = !claimResolved;
      const result = await deps.uow.run(context, work, options);
      if (first) claimResolved = true;
      return result;
    },
  };
  let result: ProcessVersionResult;
  try {
    result = await processVersion({ ...deps, uow }, { ...payload, signal: deps.signal });
  } catch (error) {
    return fail(deps, job, token, error, claimResolved);
  }
  deps.log({ level: result.outcome === "processed" ? "info" : "warn", ...describe(result) });
}

function describe(result: ProcessVersionResult): Record<string, unknown> {
  const base = { code: "INGESTION_JOB_DONE", outcome: result.outcome };
  return result.outcome === "retry" || result.outcome === "failed"
    ? { ...base, stage: result.failure.stage, failure: result.failure.code }
    : base;
}

function reject(deps: IngestionHandlerDeps, code: string): never {
  deps.log({ level: "error", code: "INGESTION_JOB_REJECTED", reason: code });
  throw new IngestionJobFailed(code);
}

async function fail(
  deps: IngestionHandlerDeps,
  job: IngestionJob,
  token: string | undefined,
  error: unknown,
  claimResolved: boolean,
): Promise<never> {
  const cause = errorCause(error);
  // A claim whose commit may have landed: neither success nor rollback can be assumed. Delivering
  // again would be safe (a landed claim is refused), but only recovery (5B) may decide.
  if (!claimResolved && error instanceof TransactionOutcomeUnknown) {
    deps.log({ level: "error", code: "INGESTION_CLAIM_OUTCOME_UNKNOWN", cause });
    throw new IngestionJobFailed("claim.outcome_unknown");
  }
  if (!claimResolved && isTransientDbError(error)) {
    // Rolled back before any claim, so redelivery consumes no attempt and cannot double-process.
    deps.log({ level: "warn", code: "INGESTION_JOB_REDELIVERED", cause });
    await job.moveToDelayed(Date.now() + deps.redeliveryDelayMs, token).catch(() => {
      throw new IngestionJobFailed("redelivery.failed");
    });
    throw new DelayedError();
  }
  // After the claim the version is running under this generation; the lease expiry returns it.
  const code = claimResolved ? "ingestion.post_claim_error" : "db.permanent_error";
  deps.log({ level: "error", code: "INGESTION_JOB_ERROR", reason: code, cause });
  throw new IngestionJobFailed(code);
}
