import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EnvError, loadWorkerEnv } from "@contextvault/config";
import { createWorkerPersistence } from "@contextvault/db";
import {
  dispatchOutbox,
  leaseDurationMs,
  readVersionBytes,
  recoverExpiredLease,
  redriveOrphan,
  sweepRecovery,
} from "@contextvault/domain";
import { parseInChild, parseLimits } from "@contextvault/ingestion";
import { createS3DocumentStore } from "@contextvault/storage";
import { createIngestionConsumer } from "./ingestion/ingestion-consumer";
import { createIngestionStages } from "./ingestion/ingestion-stages";
import { createParsedHandoff } from "./ingestion/parsed-handoff";
import { fail, installProcessGuards } from "./process-guards";
import { createJobQueue } from "./queue/bullmq-job-queue";
import { startDispatcherLoop } from "./queue/dispatcher-loop";
import { closeProducer, connectProducer } from "./queue/producer-connection";
import { startRecoverySweeper } from "./recovery/recovery-sweeper";

const batchSize = 50;
const sweepIntervalMs = 30_000;
const log = (entry: Record<string, unknown>): void => console.error(JSON.stringify(entry));

// The built parser child sits next to this file (tsdown's second entry).
const parserChildPath = fileURLToPath(new URL("./parse-child.mjs", import.meta.url));

// The outbox dispatcher, the recovery sweeper and the BullMQ consumer that parses what they queue.
async function bootstrap(): Promise<void> {
  const env = loadWorkerEnv();
  const redis = await connectProducer(env.REDIS_URL);
  const queue = createJobQueue({ connection: redis });
  const persistence = createWorkerPersistence({ connectionString: env.DATABASE_WORKER_URL });
  const deps = { source: persistence.source, queue, uow: persistence.unitOfWork };
  const loop = startDispatcherLoop({
    scan: (after) => dispatchOutbox(deps, batchSize, after),
    pollMs: 1_000,
    maxBackoffMs: 30_000,
    log,
  });
  const sweepDeps = {
    recoverySource: persistence.recoverySource,
    orphanSource: persistence.orphanSource,
    recover: (input: Parameters<typeof recoverExpiredLease>[1]) =>
      recoverExpiredLease({ uow: persistence.recoveryUnitOfWork, newId: randomUUID }, input),
    redrive: (input: Parameters<typeof redriveOrphan>[1]) =>
      redriveOrphan({ uow: persistence.orphanUnitOfWork, newId: randomUUID }, input),
    leaseDurationMs,
  };
  const store = createS3DocumentStore(env, { maxBytes: parseLimits.maxInputBytes });
  const stages = createIngestionStages({
    readBytes: (input) =>
      readVersionBytes(
        { uow: persistence.parseSourceUnitOfWork, store },
        { ...input, maxBytes: parseLimits.maxInputBytes },
      ),
    parse: (bytes, signal) => parseInChild(bytes, signal, { childPath: parserChildPath }),
    handoff: createParsedHandoff(),
    newId: randomUUID,
  });
  const consumer = await createIngestionConsumer({
    redisUrl: env.REDIS_URL,
    uow: persistence.unitOfWork,
    stages,
    newId: randomUUID,
    log,
  });
  const sweeper = startRecoverySweeper({
    sweep: (signal) => sweepRecovery(sweepDeps, batchSize, signal),
    intervalMs: sweepIntervalMs,
    log,
  });

  let stopping = false;
  // Order matters: stop polling and let the work in flight finish before its dependencies close.
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    // The consumer goes first: jobs in flight finish (or are cancelled) before anything they use closes.
    Promise.all([consumer.close(), loop.stop(), sweeper.stop()])
      .then(() => queue.close())
      .then(() => closeProducer(redis))
      .then(() => store.onModuleDestroy())
      .then(() => persistence.close())
      .then(
        () => process.exit(0),
        () => fail("SHUTDOWN_FAILED"),
      );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  console.info(JSON.stringify({ level: "info", msg: "worker ready" }));
}

installProcessGuards();
bootstrap().catch((error: unknown) => {
  if (error instanceof EnvError) console.error(error.message);
  fail("BOOTSTRAP_FAILED");
});
