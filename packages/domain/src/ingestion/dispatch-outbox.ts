import type { OutboxId } from "../kernel/ids";
import type {
  IngestionRepository,
  IngestionUnitOfWork,
  JobQueue,
  OutboxCursor,
  OutboxEntry,
  OutboxSource,
} from "./ports";

export interface DispatchOutboxDeps {
  readonly source: OutboxSource;
  readonly queue: JobQueue;
  readonly uow: IngestionUnitOfWork;
  /** Statement and lock-wait bound of the marking transaction. Default 10 s. */
  readonly transactionTimeoutMs?: number;
  /** Failures in a row (enqueue or mark) after which a scan stops. Default 3. */
  readonly maxConsecutiveFailures?: number;
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
  /** Left unchanged, or with an unknown outcome; a later scan retries them. Never thrown, so the caller must read it. */
  readonly failures: readonly DispatchFailure[];
  /** Where the next scan resumes; `null` once the end was reached, so the next starts from the oldest entry. */
  readonly next: OutboxCursor | null;
  /** The scan stopped early on consecutive failures: a dependency is probably down, so back off. */
  readonly aborted: boolean;
}

// BullMQ rejects ':' in custom ids.
export const outboxJobId = (id: OutboxId): string => `outbox-${id}`;

/**
 * Enqueue, then mark. The enqueue happens outside any transaction and is idempotent by job id, so
 * a crash, timeout or lost acknowledgement between the two steps only repeats a no-op add. A failed
 * or ambiguous enqueue changes nothing in PostgreSQL: the job may exist, so the entry is neither
 * deferred nor marked and the next scan retries the same job id. Marking the row and moving
 * `uploaded` to `queued` share one transaction; a retry's version is already `queued`.
 *
 * A scan resumes `after` a cursor and moves it past every entry it attempted, so a failing entry
 * cannot keep newer ones from being tried; the caller starts over when `next` is `null`.
 */
export async function dispatchOutbox(
  deps: DispatchOutboxDeps,
  limit: number,
  after?: OutboxCursor | null,
): Promise<DispatchOutboxResult> {
  const maxFailures = deps.maxConsecutiveFailures ?? 3;
  const entries = await deps.source.listDue(limit, after ?? undefined);
  let dispatched = 0;
  let alreadyDispatched = 0;
  let consecutive = 0;
  const failures: DispatchFailure[] = [];
  let last: OutboxEntry | undefined;
  for (const entry of entries) {
    last = entry;
    try {
      await deps.queue.enqueue({
        jobId: outboxJobId(entry.id),
        workspaceId: entry.workspaceId,
        versionId: entry.versionId,
      });
      const won = await deps.uow.run(
        { workspaceId: entry.workspaceId },
        ({ ingestion }) => markAndQueue(ingestion, entry),
        { timeoutMs: deps.transactionTimeoutMs ?? 10_000 },
      );
      if (won) dispatched += 1;
      else alreadyDispatched += 1;
      consecutive = 0;
    } catch (error) {
      // After an unknown commit the mark may have landed; a later scan finds out.
      failures.push({ outboxId: entry.id, error });
      consecutive += 1;
      if (consecutive >= maxFailures) {
        return { dispatched, alreadyDispatched, failures, next: last.cursor, aborted: true };
      }
    }
  }
  const exhausted = entries.length < limit;
  const next = exhausted || last === undefined ? null : last.cursor;
  return { dispatched, alreadyDispatched, failures, next, aborted: false };
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
