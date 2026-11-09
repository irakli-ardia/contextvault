import { randomUUID } from "node:crypto";
import { loadWorkerDatabaseEnv } from "@contextvault/config";
import {
  type DocumentVersionId,
  parseOutboxId,
  redriveOrphan,
  type WorkspaceId,
} from "@contextvault/domain";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Executor } from "../../client";
import { establishWorkerContext } from "../../context";
import { createOrphanRepository } from "../../repositories/ingestion/orphan-repository";
import { postgresErrorCode } from "../../repositories/workspaces/postgres-error";
import { createIngestionHarness } from "../../testing/ingestion-test-support";
import { seedOrphan } from "./orphan-test-support";

// The orphan path as the NOBYPASSRLS `contextvault_worker` role. Cases that pair a workspace's
// repository with another workspace's asserted context separate the repository's own SQL
// predicate from the RLS policies, which must hold on their own.
const h = await createIngestionHarness();
const { wsA, wsB } = h;
// One connection: every transaction below reuses the same backend.
const single = createDatabase({
  connectionString: loadWorkerDatabaseEnv().DATABASE_WORKER_URL,
  poolSize: 1,
});

afterAll(async () => {
  await single.close();
  await h.close();
});

const asserting = <T>(workspaceId: WorkspaceId, work: (tx: Executor) => Promise<T>): Promise<T> =>
  single.db.transaction(async (tx) => {
    await establishWorkerContext(tx, { workspaceId });
    return work(tx);
  });

/** True while another session holds the version row's lock. */
async function lockedByAnother(id: DocumentVersionId): Promise<boolean> {
  try {
    await h.fx.fixture.query(
      "select 1 from document_versions where id = $1 for no key update nowait",
      [id],
    );
    return false;
  } catch (error) {
    if (postgresErrorCode(error) === "55P03") return true;
    throw error;
  }
}

describe("lockOrphan across workspaces", () => {
  it("locks and returns the version of the asserted workspace (control)", async () => {
    const id = await seedOrphan(h, wsA);
    await asserting(wsA, async (tx) => {
      expect(
        await createOrphanRepository(tx, wsA).lockOrphan({ versionId: id, historyCap: 11 }),
      ).not.toBeNull();
      expect(await lockedByAnother(id)).toBe(true);
    });
    expect(await lockedByAnother(id)).toBe(false);
  });

  it("the repository's own workspace predicate refuses another workspace's version, locking nothing", async () => {
    const other = await seedOrphan(h, wsB);
    await asserting(wsA, async (tx) => {
      expect(
        await createOrphanRepository(tx, wsA).lockOrphan({ versionId: other, historyCap: 11 }),
      ).toBeNull();
      expect(await lockedByAnother(other)).toBe(false);
    });
  });

  it("RLS alone refuses it when the predicate names the version's own workspace", async () => {
    const other = await seedOrphan(h, wsB);
    await asserting(wsA, async (tx) => {
      // Predicate says B, context says A: only the UPDATE policy stands between this and the lock.
      const repo = createOrphanRepository(tx, wsB);
      expect(await repo.lockOrphan({ versionId: other, historyCap: 11 })).toBeNull();
      expect(await lockedByAnother(other)).toBe(false);
    });
  });

  it("a lock with no workspace predicate sees the row but cannot take it", async () => {
    const other = await seedOrphan(h, wsB);
    await asserting(wsA, async (tx) => {
      const visible = await tx.execute(sql`select id from document_versions where id = ${other}`);
      expect(visible.rows).toHaveLength(1); // worker discovery policy: lifecycle rows are readable
      const locked = await tx.execute(
        sql`select id from document_versions where id = ${other} for no key update`,
      );
      expect(locked.rows).toHaveLength(0);
      expect(await lockedByAnother(other)).toBe(false);
    });
  });

  it("a redrive of another workspace's version writes nothing, and the owner can still redrive it", async () => {
    const other = await seedOrphan(h, wsB);
    const redriveAs = (workspaceId: WorkspaceId) =>
      redriveOrphan(
        { uow: h.worker.orphanUnitOfWork, newId: randomUUID },
        { workspaceId, versionId: other },
      );
    expect(await redriveAs(wsA)).toEqual({ outcome: "skipped" });
    expect(await h.outboxRows(other)).toEqual([]);
    expect(await redriveAs(wsB)).toEqual({ outcome: "redriven" });
  });
});

describe("outbox insert under a mismatched context", () => {
  const entryFor = (workspaceId: WorkspaceId, versionId: DocumentVersionId) => ({
    id: parseOutboxId(randomUUID()),
    workspaceId,
    versionId,
    delayMs: 0,
  });

  it("is denied by RLS, and leaves no entry", async () => {
    const other = await seedOrphan(h, wsB);
    const attempt = h.worker.orphanUnitOfWork.run({ workspaceId: wsA }, async ({ ingestion }) => {
      await ingestion.insertOutbox(entryFor(wsB, other));
    });
    await expect(attempt).rejects.toSatisfy((e) => postgresErrorCode(e) === "42501");
    expect(await h.outboxRows(other)).toEqual([]);
  });

  it("is allowed for the asserted workspace (control)", async () => {
    const id = await seedOrphan(h, wsA);
    await h.worker.orphanUnitOfWork.run({ workspaceId: wsA }, ({ ingestion }) =>
      ingestion.insertOutbox(entryFor(wsA, id)),
    );
    expect(await h.outboxRows(id)).toHaveLength(1);
  });
});

describe("pooled connections", () => {
  const backend = (tx: Executor) =>
    tx.execute<{ pid: number; ws: string }>(
      sql`select pg_backend_pid() as pid, current_setting('app.workspace_id', true) as ws`,
    );

  it("carry no workspace from one transaction to the next, committed or failed", async () => {
    const mine = await seedOrphan(h, wsA);
    const first = await asserting(wsA, async (tx) => (await backend(tx)).rows[0]);
    expect(first?.ws).toBe(wsA);

    await expect(
      asserting(wsB, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A transaction that asserts nothing, on the same backend: no stale context, nothing lockable.
    const bare = await single.db.transaction(async (tx) => {
      const seen = (await backend(tx)).rows[0];
      const locked = await tx.execute(
        sql`select id from document_versions where id = ${mine} for no key update`,
      );
      return { seen, locked: locked.rows.length };
    });
    expect(bare.seen?.pid).toBe(first?.pid);
    expect(bare.seen?.ws).toBe("");
    expect(bare.locked).toBe(0);
  });
});
