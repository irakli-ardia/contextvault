import { EnvError, loadWorkerEnv } from "@contextvault/config";
import { createWorkerPersistence } from "@contextvault/db";
import { dispatchOutbox } from "@contextvault/domain";
import { createJobQueue } from "./bullmq-job-queue";
import { startDispatcherLoop } from "./dispatcher-loop";
import { fail, installProcessGuards } from "./process-guards";
import { closeProducer, connectProducer } from "./producer-connection";

const batchSize = 50;
const log = (entry: Record<string, unknown>): void => console.error(JSON.stringify(entry));

// Only the outbox dispatcher runs here; no BullMQ Worker or processing handler yet.
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

  let stopping = false;
  // Order matters: stop polling and let the scan in flight finish before its dependencies close.
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    loop
      .stop()
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
