import { randomUUID } from "node:crypto";
import { loadWorkerDatabaseEnv } from "@contextvault/config";
import {
  type DocumentVersionId,
  type IngestionRepository,
  type NewOutboxEntry,
  type OutboxSource,
  parseOutboxId,
  type VersionStatus,
  type WorkspaceId,
} from "@contextvault/domain";
import { seedDocument } from "./document-fixture";
import { createTenantFixture } from "./tenant-fixture";
import { createWorkerPersistence } from "./worker-persistence";

export interface VersionRow {
  status: string;
  lease_generation: number;
  attempt: number;
  error_stage: string | null;
  error_code: string | null;
  error_retryable: boolean | null;
  updated_at: Date;
}
export interface OutboxRow {
  id: string;
  workspace_id: string;
  version_id: string;
  available_at: Date;
  dispatched_at: Date | null;
  /** `available_at - created_at`: both are the writing transaction's `now()` plus the delay. */
  delay_ms: number;
}

export const entryFor = (
  workspaceId: WorkspaceId,
  versionId: DocumentVersionId,
  delayMs = 0,
): NewOutboxEntry => ({ id: parseOutboxId(randomUUID()), workspaceId, versionId, delayMs });

export async function createIngestionHarness() {
  const fx = await createTenantFixture();
  const worker = createWorkerPersistence({
    connectionString: loadWorkerDatabaseEnv().DATABASE_WORKER_URL,
    poolSize: 8,
  });
  const [userA, userB] = await Promise.all([fx.seedUser(), fx.seedUser()]);
  const wsA = await fx.createWorkspace(userA, "A");
  const wsB = await fx.createWorkspace(userB, "B");
  const owners = new Map([
    [wsA, userA],
    [wsB, userB],
  ]);

  const run = <T>(workspaceId: WorkspaceId, work: (repo: IngestionRepository) => Promise<T>) =>
    worker.unitOfWork.run({ workspaceId }, ({ ingestion }) => work(ingestion));

  /**
   * The real source, narrowed to this harness's workspaces: other test files share the database,
   * and a dispatcher must never mark or defer their entries. It over-fetches, then cuts to `limit`.
   */
  const ownSource: OutboxSource = {
    listDue: async (limit) =>
      (await worker.source.listDue(1_000)).filter((e) => owners.has(e.workspaceId)).slice(0, limit),
  };

  return {
    fx,
    worker,
    ownSource,
    userA,
    userB,
    wsA,
    wsB,
    run,
    /**
     * A finalized document (version `uploaded`) with one live outbox entry due after
     * `outboxDelayMs` (default: now) on the database clock; `null` seeds none.
     */
    async seed(
      workspaceId: WorkspaceId,
      options: { outboxDelayMs?: number | null; status?: VersionStatus; attempt?: number } = {},
    ): Promise<DocumentVersionId> {
      const owner = owners.get(workspaceId);
      if (owner === undefined) throw new Error("unknown workspace");
      const { versionId } = await seedDocument(fx, workspaceId, owner);
      const delayMs = options.outboxDelayMs === undefined ? 0 : options.outboxDelayMs;
      // The upload already wrote the entry, due now: remove it, or move its due time.
      await fx.fixture.query(
        delayMs === null
          ? "delete from outbox where version_id = $1"
          : "update outbox set available_at = created_at + $2 * interval '1 millisecond' where version_id = $1",
        delayMs === null ? [versionId] : [versionId, delayMs],
      );
      await fx.fixture.query(
        "update document_versions set status = $2, attempt = $3 where id = $1",
        [versionId, options.status ?? "uploaded", options.attempt ?? 0],
      );
      return versionId;
    },
    async row(versionId: string): Promise<VersionRow> {
      const { rows } = await fx.fixture.query<VersionRow>(
        `select status, lease_generation, attempt, error_stage, error_code, error_retryable,
           updated_at from document_versions where id = $1`,
        [versionId],
      );
      const [row] = rows;
      if (row === undefined) throw new Error("version not found");
      return row;
    },
    async outboxRows(versionId: string): Promise<OutboxRow[]> {
      const { rows } = await fx.fixture.query<OutboxRow>(
        `select id, workspace_id, version_id, available_at, dispatched_at,
           (extract(epoch from available_at - created_at) * 1000)::float8 as delay_ms
         from outbox where version_id = $1 order by created_at, available_at`,
        [versionId],
      );
      return rows;
    },
    /** Lets time pass without a clock seam: the live entry becomes due by the database clock. */
    async makeDue(versionId: string): Promise<void> {
      await fx.fixture.query(
        `update outbox set available_at = now() - interval '1 second'
         where version_id = $1 and dispatched_at is null`,
        [versionId],
      );
    },
    /** Dispatches or ages nothing: closes every live entry of this harness's workspaces. */
    async drainOutbox(): Promise<void> {
      await fx.fixture.query(
        `update outbox set dispatched_at = now()
         where workspace_id = any($1::uuid[]) and dispatched_at is null`,
        [[...owners.keys()]],
      );
    },
    async close() {
      await worker.close();
      await fx.close();
    },
  };
}
