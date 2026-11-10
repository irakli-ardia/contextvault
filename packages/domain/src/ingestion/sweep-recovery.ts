import type { DeadlineSignal } from "../documents/ports";
import type { OrphanSource } from "./orphan-ports";
import type { RecoverExpiredLeaseInput, RecoverExpiredLeaseResult } from "./recover-expired-lease";
import type { RecoverySource } from "./recovery-ports";
import type { RedriveOrphanInput, RedriveOrphanResult } from "./redrive-orphan";

export interface SweepRecoveryDeps {
  readonly recoverySource: RecoverySource;
  readonly orphanSource: OrphanSource;
  readonly recover: (input: RecoverExpiredLeaseInput) => Promise<RecoverExpiredLeaseResult>;
  readonly redrive: (input: RedriveOrphanInput) => Promise<RedriveOrphanResult>;
  readonly leaseDurationMs: number;
}

export interface SweepBatch {
  /** Candidates discovered (at most the batch size). */
  readonly candidates: number;
  /** Acted on: re-queued, failed or redriven. */
  readonly acted: number;
  /** Ineligible at lock time: a normal race, or still cooling down. */
  readonly skipped: number;
  /** Threw; the next sweep retries them. Errors are returned, never thrown. */
  readonly errors: readonly unknown[];
}

export interface SweepRecoveryResult {
  readonly leases: SweepBatch;
  readonly orphans: SweepBatch;
}

/** Warn-worthy: candidates were found and every one was ineligible at lock time (design D4). */
export const fullySkipped = (batch: SweepBatch): boolean =>
  batch.candidates > 0 && batch.skipped === batch.candidates;

async function runBatch<C>(
  candidates: readonly C[],
  step: (candidate: C) => Promise<"acted" | "skipped">,
  signal: DeadlineSignal | undefined,
): Promise<SweepBatch> {
  let acted = 0;
  let skipped = 0;
  const errors: unknown[] = [];
  // Sequential on purpose: each step is one short transaction, and the batch size bounds the sweep.
  for (const candidate of candidates) {
    // Cooperative: checked only between transactions, so a running one always commits or rolls back whole.
    if (signal?.aborted) break;
    try {
      if ((await step(candidate)) === "acted") acted += 1;
      else skipped += 1;
    } catch (error) {
      errors.push(error);
    }
  }
  return { candidates: candidates.length, acted, skipped, errors };
}

/**
 * One bounded pass: at most `batchSize` expired leases, then at most `batchSize` orphans (one page,
 * no cursor: acted-on versions leave the candidate set, and a skipped one is retried next sweep).
 * Discovery is advisory; `recoverExpiredLease` and `redriveOrphan` re-check everything under the
 * row lock, so repeating or overlapping sweeps is idempotent. A failing candidate never stops the
 * rest. Discovery failures propagate to the caller. Once `signal` aborts, no further candidate
 * is started and no further discovery runs; the transaction in flight finishes.
 */
export async function sweepRecovery(
  deps: SweepRecoveryDeps,
  batchSize: number,
  signal?: DeadlineSignal,
): Promise<SweepRecoveryResult> {
  const leases = await runBatch(
    signal?.aborted
      ? []
      : await deps.recoverySource.listExpiredLeases(batchSize, deps.leaseDurationMs),
    async (c) => ((await deps.recover(c)).outcome === "skipped" ? "skipped" : "acted"),
    signal,
  );
  const orphans = await runBatch(
    signal?.aborted ? [] : await deps.orphanSource.listWaiting(batchSize),
    async (c) => ((await deps.redrive(c)).outcome === "skipped" ? "skipped" : "acted"),
    signal,
  );
  return { leases, orphans };
}
