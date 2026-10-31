import type { IngestionUnitOfWork, StageRunner } from "@contextvault/domain";
import { Worker } from "bullmq";
import { ingestionQueueName, processJobName } from "./bullmq-job-queue";
import { connectConsumer } from "./consumer-connection";
import { errorCause } from "./error-cause";
import { handleIngestionJob } from "./ingestion-handler";
import { closeProducer } from "./producer-connection";

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
}

export interface IngestionConsumer {
  /** Waits for jobs in flight, then releases every connection. */
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
  const redis = await connectConsumer(options.redisUrl);
  const deps = {
    uow: options.uow,
    stages: options.stages,
    newId: options.newId,
    log,
    redeliveryDelayMs: options.redeliveryDelayMs ?? 5_000,
    signal: new AbortController().signal,
    processJobName,
  };
  let worker: Worker<unknown> | undefined;
  try {
    worker = new Worker<unknown>(
      options.queueName ?? ingestionQueueName,
      (job, token) => handleIngestionJob(deps, job, token),
      { connection: redis, concurrency: options.concurrency ?? 2 },
    );
    worker.on("error", (error) => {
      log({ level: "error", code: "CONSUMER_ERROR", cause: errorCause(error) });
    });
    await worker.waitUntilReady();
  } catch (error) {
    await worker?.close(true).catch(() => undefined);
    await closeProducer(redis);
    throw error;
  }
  const started = worker;
  return {
    async close() {
      try {
        await started.close();
      } finally {
        await closeProducer(redis);
      }
    },
  };
}
