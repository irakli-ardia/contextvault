import { randomUUID } from "node:crypto";
import {
  type DocumentVersionId,
  type RecoveryUnitOfWork,
  recoverExpiredLease,
  type WorkspaceId,
} from "@contextvault/domain";
import type { createIngestionHarness } from "./testing/ingestion-test-support";

export type Harness = Awaited<ReturnType<typeof createIngestionHarness>>;

const ageOf = 600_000;

/**
 * A claimed version whose worker died: running, `generation` held, the lease last renewed `ageMs`
 * ago on the database clock, and the consumed outbox entry already dispatched (as `claim` leaves it).
 */
export async function seedRunning(
  h: Harness,
  workspaceId: WorkspaceId,
  options: {
    status?: "parsing" | "chunking";
    attempt?: number;
    generation?: number;
    ageMs?: number;
  } = {},
): Promise<{ id: DocumentVersionId; generation: number }> {
  const { status = "parsing", attempt = 1, generation = 1, ageMs = ageOf } = options;
  const id = await h.seed(workspaceId, { status, attempt });
  await h.fx.fixture.query(
    `update document_versions set lease_generation = $2,
       updated_at = now() - $3 * interval '1 millisecond' where id = $1`,
    [id, generation, ageMs],
  );
  await h.fx.fixture.query("update outbox set dispatched_at = now() where version_id = $1", [id]);
  return { id, generation };
}

export const recover = (
  uow: RecoveryUnitOfWork,
  workspaceId: WorkspaceId,
  versionId: DocumentVersionId,
  observedGeneration: number,
) =>
  recoverExpiredLease({ uow, newId: randomUUID }, { workspaceId, versionId, observedGeneration });

/**
 * Wraps a unit of work so each transaction stays open after its work finished, until released:
 * an explicit barrier instead of a sleep. `entered` resolves once the work ran inside the open
 * transaction; the commit happens only after `release()`.
 */
export function gated(uow: RecoveryUnitOfWork) {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const wrapped: RecoveryUnitOfWork = {
    run: (context, work, options) =>
      uow.run(
        context,
        async (repos) => {
          const result = await work(repos);
          entered.resolve();
          await gate.promise;
          return result;
        },
        options,
      ),
  };
  return { uow: wrapped, entered: entered.promise, release: gate.resolve };
}

/**
 * Polls until a backend is blocked behind another transaction's write to this version's row.
 * A writer that finds the row locked first takes the heavyweight tuple lock on the row's current
 * (committed) tuple, then waits on the holder's transaction id: that pair, on this row's ctid,
 * identifies the intended waiter whatever other statements run concurrently. Bound parameters
 * never appear in `pg_stat_activity.query`, so the statement text cannot name the version.
 */
export async function waitUntilBlocked(h: Harness, versionId: DocumentVersionId): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rowCount } = await h.fx.fixture.query(
      `select 1 from document_versions dv
         join pg_locks t on t.locktype = 'tuple' and t.granted
           and t.relation = 'document_versions'::regclass
           and t.page = (dv.ctid::text::point)[0]::int and t.tuple = (dv.ctid::text::point)[1]::int
         join pg_locks w on w.pid = t.pid and w.locktype = 'transactionid' and not w.granted
         where dv.id = $1`,
      [versionId],
    );
    if (rowCount !== null && rowCount > 0) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`no backend became blocked on the row lock of version ${versionId}`);
}
