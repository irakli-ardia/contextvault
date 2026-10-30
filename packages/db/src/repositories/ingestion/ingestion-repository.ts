import {
  canTransition,
  type IngestionRepository,
  isRunning,
  isVersionStatus,
  maxAttempts,
  parseDocumentVersionId,
  type WorkspaceId,
} from "@contextvault/domain";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "../../client";
import { documentVersions, outbox } from "../../schema/index";

// Schedules are the database's `now()` plus a delay, never an application timestamp: no clock
// but PostgreSQL's decides whether an entry is due or a delivery early.
const delayed = (delayMs: number) => sql`now() + make_interval(secs => ${delayMs / 1000})`;

// Every query repeats the workspace predicate. The worker's discovery policy lets it read lifecycle
// rows of every workspace, so RLS alone would not keep a lookup inside the job's workspace; the
// UPDATE and INSERT policies bind writes as well, and this predicate is the first line, not the last.
export function createIngestionRepository(
  executor: Executor,
  workspaceId: WorkspaceId,
): IngestionRepository {
  const inWorkspace = (versionId: string) =>
    and(eq(documentVersions.id, versionId), eq(documentVersions.workspaceId, workspaceId));
  const liveOutbox = (versionId: string) =>
    and(
      eq(outbox.workspaceId, workspaceId),
      eq(outbox.versionId, versionId),
      isNull(outbox.dispatchedAt),
    );
  const fenced = (versionId: string, leaseGeneration: number) =>
    and(inWorkspace(versionId), eq(documentVersions.leaseGeneration, leaseGeneration));

  return {
    async findVersion(versionId) {
      const [row] = await executor
        .select({
          id: documentVersions.id,
          status: documentVersions.status,
          leaseGeneration: documentVersions.leaseGeneration,
          attempt: documentVersions.attempt,
        })
        .from(documentVersions)
        .where(inWorkspace(versionId));
      if (row === undefined) return null;
      if (!isVersionStatus(row.status)) throw new Error(`Unknown version status ${row.status}`);
      return { ...row, id: parseDocumentVersionId(row.id), status: row.status };
    },

    // Raw SQL: Drizzle leaves single-table column references unqualified, which would let the
    // correlated subqueries capture `id`. One statement, so the status check, the deleted check,
    // the retry schedule, the counters and the closing of the consumed outbox entry cannot
    // interleave with another claim or be half applied. Schedules compare against the database
    // clock only. The data-modifying CTE runs whether or not it is read, and only for a won claim.
    // The first statement takes the live entry's lock before the version's, the order the
    // dispatcher's mark-then-transition uses, so the two cannot deadlock.
    async claim({ versionId }) {
      await executor.execute(sql`
        select 1 from outbox
        where workspace_id = ${workspaceId} and version_id = ${versionId} and dispatched_at is null
        for update`);
      const { rows } = await executor.execute<{ lease_generation: number; attempt: number }>(sql`
        with claimed as (
          update document_versions dv
          set status = 'parsing', lease_generation = dv.lease_generation + 1,
              attempt = dv.attempt + 1, updated_at = now()
          where dv.id = ${versionId} and dv.workspace_id = ${workspaceId}
            and dv.status in ('uploaded', 'queued') and dv.attempt < ${maxAttempts}
            and exists (select 1 from documents d
              where d.id = dv.document_id and d.workspace_id = dv.workspace_id
                and d.deleted_at is null)
            and not exists (select 1 from outbox o
              where o.workspace_id = dv.workspace_id and o.version_id = dv.id
                and o.dispatched_at is null and o.available_at > now())
          returning dv.id, dv.workspace_id, dv.lease_generation, dv.attempt),
        closed as (
          update outbox o set dispatched_at = now() from claimed c
          where o.workspace_id = c.workspace_id and o.version_id = c.id
            and o.dispatched_at is null
          returning o.id)
        select lease_generation, attempt from claimed`);
      const [row] = rows;
      return row === undefined
        ? null
        : { leaseGeneration: row.lease_generation, attempt: row.attempt };
    },

    async heartbeat({ versionId, leaseGeneration }) {
      const rows = await executor
        .update(documentVersions)
        .set({ updatedAt: sql`now()` })
        .where(
          and(
            fenced(versionId, leaseGeneration),
            inArray(documentVersions.status, ["parsing", "chunking"]),
          ),
        )
        .returning({ id: documentVersions.id });
      return rows.length === 1;
    },

    async transition({ versionId, leaseGeneration, from, to }) {
      if (!canTransition(from, to)) throw new Error(`Illegal transition ${from} -> ${to}`);
      const rows = await executor
        .update(documentVersions)
        .set({ status: to, updatedAt: sql`now()` })
        .where(and(fenced(versionId, leaseGeneration), eq(documentVersions.status, from)))
        .returning({ id: documentVersions.id });
      return rows.length === 1;
    },

    async failVersion({ versionId, leaseGeneration, from, failure }) {
      if (!canTransition(from, "failed") || !isRunning(from)) {
        throw new Error(`Illegal transition ${from} -> failed`);
      }
      const rows = await executor
        .update(documentVersions)
        .set({
          status: "failed",
          errorStage: failure.stage,
          errorCode: failure.code,
          errorRetryable: failure.retryable,
          updatedAt: sql`now()`,
        })
        .where(and(fenced(versionId, leaseGeneration), eq(documentVersions.status, from)))
        .returning({ id: documentVersions.id });
      return rows.length === 1;
    },

    // The conflict target is the live-entry index and nothing else: a duplicate primary key, a
    // foreign-key miss or a policy denial still raises. A conflict means that entry already
    // schedules the version; the lookup proves it before the insert is treated as covered.
    async insertOutbox(entry) {
      const inserted = await executor
        .insert(outbox)
        .values({
          id: entry.id,
          workspaceId: entry.workspaceId,
          versionId: entry.versionId,
          kind: "process_version",
          availableAt: delayed(entry.delayMs),
        })
        .onConflictDoNothing({
          target: [outbox.workspaceId, outbox.versionId],
          where: isNull(outbox.dispatchedAt),
        })
        .returning({ id: outbox.id });
      if (inserted.length === 1) return;
      const [live] = await executor
        .select({ id: outbox.id })
        .from(outbox)
        .where(liveOutbox(entry.versionId));
      if (live === undefined) throw new Error("Outbox insert conflicted without a live entry");
    },

    async markDispatched(outboxId) {
      const rows = await executor
        .update(outbox)
        .set({ dispatchedAt: sql`now()` })
        .where(
          and(
            eq(outbox.id, outboxId),
            eq(outbox.workspaceId, workspaceId),
            isNull(outbox.dispatchedAt),
          ),
        )
        .returning({ id: outbox.id });
      return rows.length === 1;
    },
  };
}
