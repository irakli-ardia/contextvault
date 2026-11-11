import type {
  IngestionUnitOfWork,
  OrphanSource,
  OrphanUnitOfWork,
  OutboxSource,
  ParseSourceUnitOfWork,
  PurgeSource,
  PurgeUnitOfWork,
  RecoverySource,
  RecoveryUnitOfWork,
} from "@contextvault/domain";
import { createDatabase } from "./client";
import { establishWorkerContext } from "./context";
import { createIngestionRepository } from "./repositories/ingestion/ingestion-repository";
import { createOrphanRepository } from "./repositories/ingestion/orphan-repository";
import { createOrphanSource } from "./repositories/ingestion/orphan-source";
import { createOutboxSource } from "./repositories/ingestion/outbox-source";
import { createParseSourceRepository } from "./repositories/ingestion/parse-source-repository";
import { createPurgeRepository } from "./repositories/ingestion/purge-repository";
import { createPurgeSource } from "./repositories/ingestion/purge-source";
import { createRecoveryRepository } from "./repositories/ingestion/recovery-repository";
import { createRecoverySource } from "./repositories/ingestion/recovery-source";
import { runTransaction } from "./unit-of-work";

export interface WorkerPersistence {
  readonly unitOfWork: IngestionUnitOfWork;
  readonly recoveryUnitOfWork: RecoveryUnitOfWork;
  readonly orphanUnitOfWork: OrphanUnitOfWork;
  readonly parseSourceUnitOfWork: ParseSourceUnitOfWork;
  readonly purgeUnitOfWork: PurgeUnitOfWork;
  readonly purgeSource: PurgeSource;
  readonly source: OutboxSource;
  readonly recoverySource: RecoverySource;
  readonly orphanSource: OrphanSource;
  readonly close: () => Promise<void>;
}

// For the connection of the NOBYPASSRLS `contextvault_worker` role only; the worker's composition
// root passes `DATABASE_WORKER_URL`. Each unit of work asserts the job's workspace and nothing else.
// The recovery unit of work opens the same kind of transaction and hands both repositories the
// same executor, so an expired-lease bump and the retry it schedules commit or roll back together.
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
    recoveryUnitOfWork: {
      run: (context, work, runOptions) =>
        runTransaction(
          db,
          runOptions?.timeoutMs,
          (tx) => establishWorkerContext(tx, context),
          (tx) =>
            work({
              recovery: createRecoveryRepository(tx, context.workspaceId),
              ingestion: createIngestionRepository(tx, context.workspaceId),
            }),
        ),
    },
    orphanUnitOfWork: {
      run: (context, work, runOptions) =>
        runTransaction(
          db,
          runOptions?.timeoutMs,
          (tx) => establishWorkerContext(tx, context),
          (tx) =>
            work({
              orphan: createOrphanRepository(tx, context.workspaceId),
              ingestion: createIngestionRepository(tx, context.workspaceId),
            }),
        ),
    },
    parseSourceUnitOfWork: {
      run: (context, work, runOptions) =>
        runTransaction(
          db,
          runOptions?.timeoutMs,
          (tx) => establishWorkerContext(tx, context),
          (tx) => work({ parseSource: createParseSourceRepository(tx, context.workspaceId) }),
        ),
    },
    purgeUnitOfWork: {
      run: (context, work, runOptions) =>
        runTransaction(
          db,
          runOptions?.timeoutMs,
          (tx) => establishWorkerContext(tx, context),
          (tx) => work({ purge: createPurgeRepository(tx, context.workspaceId) }),
        ),
    },
    purgeSource: createPurgeSource(db),
    source: createOutboxSource(db),
    recoverySource: createRecoverySource(db),
    orphanSource: createOrphanSource(db),
    close,
  };
}
