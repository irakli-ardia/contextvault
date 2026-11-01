import {
  type IngestionUnitOfWork,
  type ProcessVersionDeps,
  type ProcessVersionResult,
  processVersion,
  TransactionOutcomeUnknown,
} from "@contextvault/domain";
import { DelayedError, UnrecoverableError } from "bullmq";
import { errorCause } from "./error-cause";
import { parseIngestionPayload } from "./ingestion-job";
import { withHeartbeat } from "./lease-heartbeat";
import { redeliveryDelayMs } from "./redelivery-delay";
import { isTransientDbError } from "./transient-db-error";

/** The part of a BullMQ job the handler uses. */
export interface IngestionJob {
  readonly name: string;
  readonly data: unknown;
  /** BullMQ counts every pickup, this one included, from 1. */
  readonly attemptsStarted?: number | undefined;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

export interface IngestionHandlerDeps extends ProcessVersionDeps {
  readonly log: (entry: Record<string, unknown>) => void;
  /** Wait before a job that never reached a claim is delivered again. */
  readonly redeliveryDelayMs: number;
  /** Jitter source in [0, 1), injectable so tests are deterministic. */
  readonly random: () => number;
  /** Lease renewal period while a stage runs, and the bound of each renewal. */
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly processJobName: string;
  /** Aborted by the consumer when shutdown cancels the jobs still running. Not an ownership loss. */
  readonly shutdown: AbortSignal;
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
  // One controller per delivery, so a lost lease cancels this job and no other; shutdown cancels
  // every job through its own signal. Both are advisory: a stage that ignores them is still
  // stopped from writing by the fenced statements.
  const controller = new AbortController();
  let leaseLost = false;
  const stages = withHeartbeat(deps.stages, {
    uow: deps.uow,
    intervalMs: deps.heartbeatIntervalMs,
    beatTimeoutMs: deps.heartbeatTimeoutMs,
    log: deps.log,
    onLost: () => {
      if (leaseLost) return;
      leaseLost = true;
      deps.log({ level: "warn", code: "INGESTION_LEASE_LOST" });
      controller.abort();
    },
  });
  let result: ProcessVersionResult;
  try {
    result = await processVersion(
      { ...deps, uow, stages },
      { ...payload, signal: AbortSignal.any([controller.signal, deps.shutdown]) },
    );
  } catch (error) {
    return fail(deps, job, token, error, claimResolved);
  }
  deps.log({
    level: result.outcome === "processed" ? "info" : "warn",
    ...describe(result),
    ...(leaseLost ? { leaseLost } : {}),
    ...(result.outcome === "aborted" && deps.shutdown.aborted ? { shutdownCancelled: true } : {}),
  });
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

/** Offers the job again after the delay without touching PostgreSQL. */
export async function redeliverLater(
  delayMs: number,
  job: Pick<IngestionJob, "moveToDelayed">,
  token: string | undefined,
): Promise<never> {
  await job.moveToDelayed(Date.now() + delayMs, token).catch(() => {
    throw new IngestionJobFailed("redelivery.failed");
  });
  throw new DelayedError();
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
    // Backs off with each pickup so a database outage is not polled at a fixed rate.
    const delay = redeliveryDelayMs(deps.redeliveryDelayMs, job.attemptsStarted, deps.random);
    return redeliverLater(delay, job, token);
  }
  // After the claim the version is running under this generation; the lease expiry returns it.
  const code = claimResolved ? "ingestion.post_claim_error" : "db.permanent_error";
  deps.log({ level: "error", code: "INGESTION_JOB_ERROR", reason: code, cause });
  throw new IngestionJobFailed(code);
}
