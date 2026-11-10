import { fullySkipped, type SweepBatch, type SweepRecoveryResult } from "@contextvault/domain";
import { errorCause } from "../error-cause";

export interface RecoverySweeperOptions {
  /**
   * One bounded sweep; throws when discovery fails (the database is down). It must stop starting
   * work once `signal` aborts and let the transaction in flight finish.
   */
  readonly sweep: (signal: AbortSignal) => Promise<SweepRecoveryResult>;
  readonly intervalMs: number;
  /** Receives codes, counts and error labels only, never error text or ids of documents. */
  readonly log: (entry: Record<string, unknown>) => void;
}

export interface RecoverySweeper {
  /** Stops scheduling, tells the sweep to stop between candidates, and resolves once the transaction in flight has finished. */
  stop(): Promise<void>;
}

const batches = (r: SweepRecoveryResult): [string, SweepBatch][] => [
  ["leases", r.leases],
  ["orphans", r.orphans],
];

/**
 * Fixed-interval sweeps: the next one is armed only when the last ends, so sweeps never overlap and
 * a slow or failing one cannot pile up retries. Failures are logged and retried at the next
 * interval; nothing is retried inside a sweep. A batch where every candidate was ineligible at lock
 * time is a warning; a partial skip is an ordinary race and is silent.
 */
export function startRecoverySweeper(options: RecoverySweeperOptions): RecoverySweeper {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    try {
      const result = await options.sweep(abort.signal);
      for (const [batch, b] of batches(result)) {
        if (fullySkipped(b)) {
          options.log({
            level: "warn",
            code: "RECOVERY_BATCH_SKIPPED",
            batch,
            candidates: b.candidates,
          });
        }
        if (b.errors.length > 0) {
          options.log({
            level: "warn",
            code: "RECOVERY_ITEMS_FAILED",
            batch,
            failures: b.errors.length,
            causes: [...new Set(b.errors.map(errorCause))].slice(0, 5),
          });
        }
        if (b.acted > 0)
          options.log({ level: "info", code: "RECOVERY_ACTED", batch, acted: b.acted });
      }
    } catch (error) {
      options.log({ level: "error", code: "RECOVERY_SWEEP_FAILED", cause: errorCause(error) });
    }
  };

  const schedule = (): void => {
    if (abort.signal.aborted) return;
    timer = setTimeout(() => {
      running = tick().then(schedule);
    }, options.intervalMs);
  };

  schedule();
  return {
    async stop() {
      abort.abort();
      clearTimeout(timer);
      await running;
    },
  };
}
