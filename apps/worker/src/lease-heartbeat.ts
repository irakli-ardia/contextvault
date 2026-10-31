import type {
  DocumentVersionId,
  IngestionUnitOfWork,
  StageInput,
  StageRunner,
} from "@contextvault/domain";
import { errorCause } from "./error-cause";

export interface HeartbeatOptions {
  readonly uow: IngestionUnitOfWork;
  /** Default 30 s, a tenth of the planned five-minute lease. */
  readonly intervalMs: number;
  /**
   * Statement bound of each renewal (the pool's connection timeout bounds the wait before it), and
   * the longest `stop` waits for a renewal still in flight.
   */
  readonly beatTimeoutMs: number;
  /** Called once, only when the database answered that this generation no longer owns the version. */
  readonly onLost: (lost: { versionId: DocumentVersionId; leaseGeneration: number }) => void;
  /** Receives codes and error labels only, never error text. */
  readonly log: (entry: Record<string, unknown>) => void;
}

/**
 * Renews the lease of the version while a stage runs. The lease is the row's `updated_at`, which
 * the claim and every transition also refresh, so the heartbeat only bridges one stage: the first
 * beat is due one interval after the stage starts and no gap longer than the interval is left.
 *
 * Only `heartbeat() === false` is ownership loss: the renewal is a single fenced UPDATE, and the
 * generation never moves back. A thrown error (including an unknown commit outcome, harmless
 * because renewing twice is idempotent) proves nothing and is retried on the next tick.
 *
 * The next beat is armed only when the last one ends, so beats never overlap. `stop` waits for the
 * one in flight, but at most `beatTimeoutMs`: Promise.race cancels nothing, so a renewal stuck on
 * a dead connection is only abandoned. It stays inside the pool until the statement timeout, the
 * connection timeout or the socket error ends it, and its answer, success or error, is dropped
 * silently. A hard end-to-end bound needs a client-side query timeout on the pool (not set here).
 */
function startHeartbeat(options: HeartbeatOptions, input: StageInput): { stop(): Promise<void> } {
  const { workspaceId, versionId, leaseGeneration, signal } = input;
  let stopped = signal.aborted;
  let failing = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const halt = (): void => {
    stopped = true;
    clearTimeout(timer);
  };

  const beat = async (): Promise<void> => {
    try {
      const owned = await options.uow.run(
        { workspaceId },
        ({ ingestion }) => ingestion.heartbeat({ versionId, leaseGeneration }),
        { timeoutMs: options.beatTimeoutMs },
      );
      // An answer that arrives after the stage ended or was cancelled decides nothing.
      if (stopped) return;
      if (!owned) {
        halt();
        options.onLost({ versionId, leaseGeneration });
        return;
      }
      if (failing) options.log({ level: "info", code: "INGESTION_HEARTBEAT_RECOVERED" });
      failing = false;
    } catch (error) {
      if (stopped) return;
      if (!failing) {
        options.log({
          level: "warn",
          code: "INGESTION_HEARTBEAT_FAILED",
          cause: errorCause(error),
        });
      }
      failing = true;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = beat().then(schedule);
    }, options.intervalMs);
  };

  signal.addEventListener("abort", halt, { once: true });
  schedule();
  return {
    async stop() {
      halt();
      signal.removeEventListener("abort", halt);
      let bound: NodeJS.Timeout | undefined;
      const abandoned = new Promise<void>((resolve) => {
        bound = setTimeout(resolve, options.beatTimeoutMs);
      });
      try {
        await Promise.race([running, abandoned]);
      } finally {
        clearTimeout(bound);
      }
    },
  };
}

/** Runs each stage under a heartbeat that stops when the stage ends or its signal aborts. */
export function withHeartbeat(stages: StageRunner, options: HeartbeatOptions): StageRunner {
  return {
    async run(input) {
      const heartbeat = startHeartbeat(options, input);
      try {
        await stages.run(input);
      } finally {
        await heartbeat.stop();
      }
    },
  };
}
