import type { DispatchOutboxResult, OutboxCursor } from "@contextvault/domain";
import { errorCause } from "./error-cause";

export interface DispatcherLoopOptions {
  /** One scan from the cursor; may throw (the database is down). */
  readonly scan: (after: OutboxCursor | null) => Promise<DispatchOutboxResult>;
  readonly pollMs: number;
  readonly maxBackoffMs: number;
  /** Receives codes, counts and error labels only, never error text. */
  readonly log: (entry: Record<string, unknown>) => void;
}

export interface DispatcherLoop {
  /** Stops polling and resolves once the scan in flight has finished. */
  stop(): Promise<void>;
}

/**
 * Timer-driven polling: the next tick is armed only when the last one ends, so ticks never overlap.
 * The cursor lives in memory and is lost on restart, which only means a scan starts from the oldest
 * entry. A scan that aborted, threw, or only failed backs off exponentially from `pollMs` up to `maxBackoffMs`;
 * the first clean scan returns to `pollMs`, and a full page is followed at once by the next.
 */
export function startDispatcherLoop(options: DispatcherLoopOptions): DispatcherLoop {
  let cursor: OutboxCursor | null = null;
  let unhealthy = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const tick = async (): Promise<number> => {
    try {
      const result = await options.scan(cursor);
      cursor = result.next;
      if (result.failures.length > 0) {
        options.log({
          level: "warn",
          code: "OUTBOX_DISPATCH_FAILED",
          failures: result.failures.length,
          causes: [...new Set(result.failures.map((f) => errorCause(f.error)))].slice(0, 5),
        });
      }
      const progressed = result.dispatched + result.alreadyDispatched > 0;
      const stalled = result.aborted || (result.failures.length > 0 && !progressed);
      unhealthy = stalled ? unhealthy + 1 : 0;
      return result.next !== null && !stalled ? 0 : options.pollMs;
    } catch (error) {
      unhealthy += 1;
      options.log({ level: "error", code: "OUTBOX_SCAN_FAILED", cause: errorCause(error) });
      return options.pollMs;
    }
  };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    const backoff =
      unhealthy === 0 ? delayMs : Math.min(options.pollMs * 2 ** unhealthy, options.maxBackoffMs);
    timer = setTimeout(() => {
      running = tick().then(schedule);
    }, backoff);
  };

  schedule(0);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
