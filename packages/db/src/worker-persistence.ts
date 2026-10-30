import type { IngestionUnitOfWork, OutboxSource } from "@contextvault/domain";
import { createDatabase } from "./client";
import { establishWorkerContext } from "./context";
import { createIngestionRepository } from "./repositories/ingestion/ingestion-repository";
import { createOutboxSource } from "./repositories/ingestion/outbox-source";
import { runTransaction } from "./unit-of-work";

export interface WorkerPersistence {
  readonly unitOfWork: IngestionUnitOfWork;
  readonly source: OutboxSource;
  readonly close: () => Promise<void>;
}

// For the connection of the NOBYPASSRLS `contextvault_worker` role only; the worker's composition
// root passes `DATABASE_WORKER_URL`. Each unit of work asserts the job's workspace and nothing else.
export function createWorkerPersistence(options: {
  connectionString: string;
  poolSize?: number;
}): WorkerPersistence {
  const { db, close } = createDatabase(options);
  return {
    unitOfWork: {
      run: (context, work, runOptions) =>
        runTransaction(
          db,
          runOptions?.timeoutMs,
          (tx) => establishWorkerContext(tx, context),
          (tx) => work({ ingestion: createIngestionRepository(tx, context.workspaceId) }),
        ),
    },
    source: createOutboxSource(db),
    close,
  };
}
