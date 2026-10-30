import type { OutboxId } from "../kernel/ids";
import type {
  IngestionRepository,
  IngestionUnitOfWork,
  JobQueue,
  OutboxEntry,
  OutboxSource,
} from "./ports";

export interface DispatchOutboxDeps {
  readonly source: OutboxSource;
  readonly queue: JobQueue;
  readonly uow: IngestionUnitOfWork;
  /** Statement and lock-wait bound of the marking transaction. Default 10 s. */
  readonly transactionTimeoutMs?: number;
}

export interface DispatchFailure {
  readonly outboxId: OutboxId;
  readonly error: unknown;
}

export interface DispatchOutboxResult {
  /** Entries this call marked dispatched. */
  readonly dispatched: number;
  /** Enqueued, but another dispatcher had already marked them. */
  readonly alreadyDispatched: number;
  /** Left undispatched, or with an unknown outcome; the next poll retries them. Never thrown, so the caller must read it. */
  readonly failures: readonly DispatchFailure[];
}

// BullMQ rejects ':' in custom ids.
export const outboxJobId = (id: OutboxId): string => `outbox-${id}`;

/**
 * Enqueue, then mark. The enqueue happens outside any transaction and is idempotent by job id, so
 * a crash or lost acknowledgement between the two steps only repeats a no-op add. Marking the row
 * and moving `uploaded` to `queued` share one transaction; a retry's version is already `queued`.
 */
export async function dispatchOutbox(
  deps: DispatchOutboxDeps,
  now: Date,
  limit: number,
): Promise<DispatchOutboxResult> {
  let dispatched = 0;
  let alreadyDispatched = 0;
  const failures: DispatchFailure[] = [];
  for (const entry of await deps.source.listDue(now, limit)) {
    try {
      await deps.queue.enqueue({
        jobId: outboxJobId(entry.id),
        workspaceId: entry.workspaceId,
        versionId: entry.versionId,
      });
      const won = await deps.uow.run(
        { workspaceId: entry.workspaceId },
        ({ ingestion }) => markAndQueue(ingestion, entry, now),
        { timeoutMs: deps.transactionTimeoutMs ?? 10_000 },
      );
      if (won) dispatched += 1;
      else alreadyDispatched += 1;
    } catch (error) {
      failures.push({ outboxId: entry.id, error });
    }
  }
  return { dispatched, alreadyDispatched, failures };
}

/** `false` when another dispatcher already marked the entry. */
async function markAndQueue(
  repo: IngestionRepository,
  entry: OutboxEntry,
  now: Date,
): Promise<boolean> {
  // The winner's transaction did the transition too.
  if (!(await repo.markDispatched(entry.id, now))) return false;
  const version = await repo.findVersion(entry.versionId);
  if (version?.status === "uploaded") {
    await repo.transition({
      versionId: version.id,
      leaseGeneration: version.leaseGeneration,
      from: "uploaded",
      to: "queued",
    });
  }
  return true;
}
