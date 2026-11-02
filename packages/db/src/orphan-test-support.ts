import type {
  DocumentVersionId,
  OrphanSnapshot,
  VersionStatus,
  WorkspaceId,
} from "@contextvault/domain";
import type { Harness } from "./recovery-test-support";

export const minute = 60_000;
export const hour = 60 * minute;
const historyCap = 11;

export interface HistoryRow {
  readonly createdAgoMs: number;
  readonly dispatchedAgoMs: number;
}

/**
 * An unclaimed version with no live outbox entry, `updated_at` `updatedAgoMs` ago and the given
 * dispatched history, all on the database clock.
 */
export async function seedOrphan(
  h: Harness,
  workspaceId: WorkspaceId,
  options: {
    status?: VersionStatus;
    attempt?: number;
    updatedAgoMs?: number;
    history?: readonly HistoryRow[];
  } = {},
): Promise<DocumentVersionId> {
  const { status = "queued", attempt = 0, updatedAgoMs = 24 * hour, history = [] } = options;
  const id = await h.seed(workspaceId, { status, attempt, outboxDelayMs: null });
  for (const row of history) {
    await h.fx.fixture.query(
      `insert into outbox (id, workspace_id, version_id, kind, available_at, created_at, dispatched_at)
       values (gen_random_uuid(), $1, $2, 'process_version', now() - $3 * interval '1 millisecond',
         now() - $3 * interval '1 millisecond', now() - $4 * interval '1 millisecond')`,
      [workspaceId, id, row.createdAgoMs, row.dispatchedAgoMs],
    );
  }
  await h.fx.fixture.query(
    "update document_versions set updated_at = now() - $2 * interval '1 millisecond' where id = $1",
    [id, updatedAgoMs],
  );
  return id;
}

export const lockOrphan = (
  h: Harness,
  workspaceId: WorkspaceId,
  versionId: DocumentVersionId,
  cap = historyCap,
) =>
  h.worker.orphanUnitOfWork.run({ workspaceId }, ({ orphan }) =>
    orphan.lockOrphan({ versionId, historyCap: cap }),
  );

/** The database clock advances between seeding and reading, so idle time is a bounded range. */
export function expectIdle(snapshot: OrphanSnapshot | null, ms: number): void {
  if (snapshot === null) throw new Error("expected a snapshot");
  if (snapshot.idleMs < ms || snapshot.idleMs > ms + 30_000) {
    throw new Error(`idleMs ${snapshot.idleMs} not within 30 s of ${ms}`);
  }
}
