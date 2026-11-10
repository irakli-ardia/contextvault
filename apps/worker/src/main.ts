import { randomUUID } from "node:crypto";
import { EnvError, loadWorkerEnv } from "@contextvault/config";
import { createWorkerPersistence } from "@contextvault/db";
import {
  dispatchOutbox,
  leaseDurationMs,
  recoverExpiredLease,
  redriveOrphan,
  sweepRecovery,
} from "@contextvault/domain";
import { fail, installProcessGuards } from "./process-guards";
import { createJobQueue } from "./queue/bullmq-job-queue";
import { startDispatcherLoop } from "./queue/dispatcher-loop";
import { closeProducer, connectProducer } from "./queue/producer-connection";
import { startRecoverySweeper } from "./recovery/recovery-sweeper";

const batchSize = 50;
const sweepIntervalMs = 30_000;
const log = (entry: Record<string, unknown>): void => console.error(JSON.stringify(entry));

// Only the outbox dispatcher and recovery sweeper run here; no BullMQ Worker or processing handler yet.
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
  const sweeper = startRecoverySweeper({
    sweep: (signal) => sweepRecovery(sweepDeps, batchSize, signal),
    intervalMs: sweepIntervalMs,
    log,
  });

  let stopping = false;
  // Order matters: stop polling and let the scan in flight finish before its dependencies close.
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    Promise.all([loop.stop(), sweeper.stop()])
      .then(() => queue.close())
      .then(() => closeProducer(redis))
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
