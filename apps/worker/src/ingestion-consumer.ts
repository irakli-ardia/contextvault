import type { IngestionUnitOfWork, StageRunner } from "@contextvault/domain";
import { Worker } from "bullmq";
import { ingestionQueueName, processJobName } from "./bullmq-job-queue";
import { closeConsumer, connectConsumer } from "./consumer-connection";
import { createActiveJobs, IngestionShutdownIncomplete, settledWithin } from "./consumer-shutdown";
import { errorCause } from "./error-cause";
import { handleIngestionJob, redeliverLater } from "./ingestion-handler";

export interface IngestionConsumerOptions {
  readonly redisUrl: string;
  readonly uow: IngestionUnitOfWork;
  readonly stages: StageRunner;
  /** A fresh random UUID for a retry's outbox row. */
  readonly newId: () => string;
  readonly log?: (entry: Record<string, unknown>) => void;
  /** Tests isolate themselves on a queue of their own. */
  readonly queueName?: string;
  /** Default 2, as planned. */
  readonly concurrency?: number;
  /** Default 5 s. */
  readonly redeliveryDelayMs?: number;
  /** Default 30 s, a tenth of the planned five-minute lease. */
  readonly heartbeatIntervalMs?: number;
  /** Bound of each lease renewal, default 5 s. */
  readonly heartbeatTimeoutMs?: number;
  /** How long `close` lets jobs in flight finish before cancelling them, default 20 s. */
  readonly drainTimeoutMs?: number;
  /** How long cancelled jobs get to return before `close` gives up on them, default 10 s. */
  readonly cancelGraceMs?: number;
  /** Bound of the Redis release once no job runs, default 5 s. */
  readonly releaseTimeoutMs?: number;
}

export interface IngestionConsumer {
  /**
   * Stops taking jobs, lets those in flight finish, cancels the rest after `drainTimeoutMs` and
   * releases every connection. Idempotent: every call returns the same outcome. Rejects with
   * `IngestionShutdownIncomplete` when stage work ignored its cancellation: the consumer is
   * stopped, but that work still runs in this process and only ending the process ends it.
   */
  close(): Promise<void>;
}

const defaultLog = (entry: Record<string, unknown>): void => console.error(JSON.stringify(entry));

/**
 * The BullMQ half of ingestion: it only delivers ids to `processVersion`. Not wired into main.ts.
 * Nothing is left open when startup fails.
 */
export async function createIngestionConsumer(
  options: IngestionConsumerOptions,
): Promise<IngestionConsumer> {
  const log = options.log ?? defaultLog;
  const drainMs = options.drainTimeoutMs ?? 20_000;
  const graceMs = options.cancelGraceMs ?? 10_000;
  const releaseMs = options.releaseTimeoutMs ?? 5_000;
  const redis = await connectConsumer(options.redisUrl);
  const cancelJobs = new AbortController();
  const jobs = createActiveJobs();
  const deps = {
    uow: options.uow,
    stages: options.stages,
    newId: options.newId,
    log,
    redeliveryDelayMs: options.redeliveryDelayMs ?? 5_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 5_000,
    processJobName,
    shutdown: cancelJobs.signal,
  };
  let stopping = false;
  let worker: Worker<unknown> | undefined;
  try {
    worker = new Worker<unknown>(
      options.queueName ?? ingestionQueueName,
      // BullMQ can still hand over a job it had already fetched when close began: it is offered
      // again untouched, so shutdown never claims a version or spends an attempt.
      (job, token) =>
        jobs.run(() =>
          stopping ? redeliverLater(deps, job, token) : handleIngestionJob(deps, job, token),
        ),
      { connection: redis, concurrency: options.concurrency ?? 2 },
    );
    worker.on("error", (error) => {
      log({ level: "error", code: "CONSUMER_ERROR", cause: errorCause(error) });
    });
    await worker.waitUntilReady();
  } catch (error) {
    await worker?.close(true).catch(() => undefined);
    await closeConsumer(redis, releaseMs);
    throw error;
  }
  const started = worker;

  // BullMQ memoizes its first close(): a later close(true) returns the same promise and does not
  // force anything, and that first close waits on every job in flight without a bound. So it is
  // started once, to stop fetching and drain, and never relied on to finish. `disconnect()` is the
  // forced end.
  async function shutdown(): Promise<void> {
    stopping = true;
    let closeError: unknown;
    const released = started.close().catch((error: unknown) => {
      closeError = error;
    });
    if (!(await settledWithin(jobs.idle(), drainMs))) {
      log({ level: "warn", code: "INGESTION_SHUTDOWN_CANCELLING", jobs: jobs.size });
      cancelJobs.abort();
      await settledWithin(jobs.idle(), graceMs);
    }
    const abandoned = jobs.size;
    if (abandoned > 0 || !(await settledWithin(released, releaseMs))) {
      log({ level: "warn", code: "INGESTION_SHUTDOWN_FORCED", abandonedJobs: abandoned });
      // Bounded too: ioredis never reports 'end' for a client that is reconnecting, and
      // disconnect() waits for it. The reconnect timer is cleared by the call itself.
      await settledWithin(
        started.disconnect().catch((error: unknown) => {
          closeError ??= error;
        }),
        releaseMs,
      );
    }
    await closeConsumer(redis, releaseMs);
    if (closeError !== undefined) {
      log({ level: "error", code: "CONSUMER_CLOSE_FAILED", cause: errorCause(closeError) });
    }
    if (abandoned > 0) {
      log({ level: "error", code: "INGESTION_SHUTDOWN_INCOMPLETE", abandonedJobs: abandoned });
      throw new IngestionShutdownIncomplete(abandoned);
    }
    if (closeError !== undefined) throw new Error("consumer.close_failed", { cause: closeError });
  }

  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= shutdown();
      return closing;
    },
  };
}
