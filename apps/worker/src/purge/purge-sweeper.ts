import type { PurgeBatch } from "@contextvault/domain";
import { errorCause } from "../error-cause";

export interface PurgeSweeperOptions {
  /** One bounded sweep; throws when discovery fails. Stops starting documents once `signal` aborts. */
  readonly sweep: (signal: AbortSignal) => Promise<PurgeBatch>;
  readonly intervalMs: number;
  /** Receives codes, counts and error labels only, never error text or ids of documents. */
  readonly log: (entry: Record<string, unknown>) => void;
}

export interface PurgeSweeper {
  /** Stops scheduling and resolves once the document being purged has finished. */
  stop(): Promise<void>;
}

/**
 * Fixed-interval purge, independent of the recovery sweeper: the next sweep is armed only when the
 * last ends, so sweeps never overlap, and a slow object store cannot delay lease recovery.
 * Failures are logged and retried at the next interval; nothing is retried inside a sweep.
 */
export function startPurgeSweeper(options: PurgeSweeperOptions): PurgeSweeper {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    try {
      const batch = await options.sweep(abort.signal);
      if (batch.errors.length > 0) {
        options.log({
          level: "warn",
          code: "PURGE_ITEMS_FAILED",
          failures: batch.errors.length,
          causes: [...new Set(batch.errors.map(errorCause))].slice(0, 5),
        });
      }
      if (batch.purged > 0) {
        options.log({ level: "info", code: "PURGE_DONE", purged: batch.purged });
      }
    } catch (error) {
      options.log({ level: "error", code: "PURGE_SWEEP_FAILED", cause: errorCause(error) });
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
