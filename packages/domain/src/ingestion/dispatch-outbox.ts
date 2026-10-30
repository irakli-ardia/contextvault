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

// A failing entry yields to newer work for this long (a poison row would otherwise fill the batch).
const deferralMs = 30_000;

// BullMQ rejects ':' in custom ids.
export const outboxJobId = (id: OutboxId): string => `outbox-${id}`;

/**
 * Enqueue, then mark. The enqueue happens outside any transaction and is idempotent by job id, so
 * a crash or lost acknowledgement between the two steps only repeats a no-op add. Marking the row
 * and moving `uploaded` to `queued` share one transaction; a retry's version is already `queued`.
 */
export async function dispatchOutbox(
  deps: DispatchOutboxDeps,
  limit: number,
): Promise<DispatchOutboxResult> {
  let dispatched = 0;
  let alreadyDispatched = 0;
  const failures: DispatchFailure[] = [];
  for (const entry of await deps.source.listDue(limit)) {
    try {
      await deps.queue.enqueue({
        jobId: outboxJobId(entry.id),
        workspaceId: entry.workspaceId,
        versionId: entry.versionId,
      });
    } catch (error) {
      failures.push({ outboxId: entry.id, error });
      await deferEntry(deps, entry, failures);
      continue;
    }
    // Never deferred from here on: the job may already be delivered, and a claim refused for a
    // future `available_at` would complete it, so the re-add (a no-op on a retained id) would
    // leave the version queued with no job. The next poll repeats the add and the mark instead.
    try {
      const won = await deps.uow.run(
        { workspaceId: entry.workspaceId },
        ({ ingestion }) => markAndQueue(ingestion, entry),
        { timeoutMs: deps.transactionTimeoutMs ?? 10_000 },
      );
      if (won) dispatched += 1;
      else alreadyDispatched += 1;
    } catch (error) {
      // After an unknown commit the mark may have landed; the next poll finds out.
      failures.push({ outboxId: entry.id, error });
    }
  }
  return { dispatched, alreadyDispatched, failures };
}

/** Only for an entry whose enqueue failed, so no job exists. A failed deferral is reported too. */
async function deferEntry(
  deps: DispatchOutboxDeps,
  entry: OutboxEntry,
  failures: DispatchFailure[],
): Promise<void> {
  try {
    await deps.uow.run(
      { workspaceId: entry.workspaceId },
      ({ ingestion }) => ingestion.deferOutbox(entry.id, deferralMs),
      { timeoutMs: deps.transactionTimeoutMs ?? 10_000 },
    );
  } catch (error) {
    failures.push({ outboxId: entry.id, error });
  }
}

/** `false` when another dispatcher already marked the entry. */
async function markAndQueue(repo: IngestionRepository, entry: OutboxEntry): Promise<boolean> {
  // The winner's transaction did the transition too.
  if (!(await repo.markDispatched(entry.id))) return false;
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
