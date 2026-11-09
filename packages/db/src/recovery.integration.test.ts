import { loadWorkerDatabaseEnv } from "@contextvault/config";
import { leaseDurationMs, type RecoveryUnitOfWork, type VersionStatus } from "@contextvault/domain";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { recover, seedRunning } from "./recovery-test-support";
import { createIngestionHarness } from "./testing/ingestion-test-support";

// Expired-lease recovery through the worker role against real PostgreSQL.
const h = await createIngestionHarness();
const { wsA, wsB } = h;
const uow = h.worker.recoveryUnitOfWork;
const workerPool = new pg.Pool({
  connectionString: loadWorkerDatabaseEnv().DATABASE_WORKER_URL,
  max: 1,
});

afterAll(async () => {
  await workerPool.end();
  await h.close();
});

const liveEntries = async (id: string) =>
  (await h.outboxRows(id)).filter((e) => e.dispatched_at === null);

describe("recoverExpiredLease", () => {
  it("re-queues an expired parsing version after 5 s with a fresh outbox id", async () => {
    const { id, generation } = await seedRunning(h, wsA, { status: "parsing", attempt: 1 });
    const [original] = await h.outboxRows(id);
    expect(await recover(uow, wsA, id, generation)).toEqual({ outcome: "retry", delayMs: 5_000 });
    expect(await h.row(id)).toMatchObject({
      status: "queued",
      lease_generation: generation + 1,
      attempt: 1,
    });
    const [live, ...others] = await liveEntries(id);
    expect(others).toEqual([]);
    expect(live?.delay_ms).toBe(5_000);
    expect(live?.id).not.toBe(original?.id);
    expect((await h.outboxRows(id)).filter((e) => e.id === original?.id)).toHaveLength(1);
  });

  it("re-queues an expired chunking version at attempt 2 after 10 s", async () => {
    const { id, generation } = await seedRunning(h, wsA, { status: "chunking", attempt: 2 });
    expect(await recover(uow, wsA, id, generation)).toEqual({ outcome: "retry", delayMs: 10_000 });
    expect(await h.row(id)).toMatchObject({ status: "queued", attempt: 2 });
    expect((await liveEntries(id))[0]?.delay_ms).toBe(10_000);
  });

  it.each(["parsing", "chunking"] as const)(
    "fails an expired %s version at attempt 3, keeping the stage",
    async (status) => {
      const { id, generation } = await seedRunning(h, wsA, { status, attempt: 3 });
      expect(await recover(uow, wsA, id, generation)).toEqual({ outcome: "failed" });
      expect(await h.row(id)).toMatchObject({
        status: "failed",
        lease_generation: generation + 1,
        attempt: 3,
        error_stage: status,
        error_code: "lease.expired",
        error_retryable: true,
      });
      expect(await liveEntries(id)).toEqual([]);
    },
  );

  it("changes nothing while the lease is live", async () => {
    const { id, generation } = await seedRunning(h, wsA, { ageMs: leaseDurationMs - 60_000 });
    const before = await h.row(id);
    expect(await recover(uow, wsA, id, generation)).toEqual({ outcome: "skipped" });
    expect(await h.row(id)).toEqual(before);
    expect(await liveEntries(id)).toEqual([]);
  });

  it("changes nothing for a stale observed generation", async () => {
    const { id, generation } = await seedRunning(h, wsA, { generation: 4 });
    const before = await h.row(id);
    expect(await recover(uow, wsA, id, generation - 1)).toEqual({ outcome: "skipped" });
    expect(await h.row(id)).toEqual(before);
  });

  it.each(["uploaded", "queued", "processed", "failed"] as const)(
    "changes nothing for a %s version, however old",
    async (status: VersionStatus) => {
      const { id } = await seedRunning(h, wsA);
      await h.fx.fixture.query("update document_versions set status = $2 where id = $1", [
        id,
        status,
      ]);
      const before = await h.row(id);
      expect(await recover(uow, wsA, id, 1)).toEqual({ outcome: "skipped" });
      expect(await h.row(id)).toEqual(before);
    },
  );

  it("never re-queues a version whose document is deleted", async () => {
    const { id, generation } = await seedRunning(h, wsA);
    await h.fx.fixture.query(
      `update documents set deleted_at = now()
       where id = (select document_id from document_versions where id = $1)`,
      [id],
    );
    const before = await h.row(id);
    expect(await recover(uow, wsA, id, generation)).toEqual({ outcome: "skipped" });
    expect(await h.row(id)).toEqual(before);
    expect(await liveEntries(id)).toEqual([]);
  });

  it("does not let workspace B recover workspace A's version", async () => {
    const { id, generation } = await seedRunning(h, wsA);
    const before = await h.row(id);
    expect(await recover(uow, wsB, id, generation)).toEqual({ outcome: "skipped" });
    expect(await h.row(id)).toEqual(before);
  });
});

describe("rollback", () => {
  it("undoes the generation bump when the transaction fails after the CAS", async () => {
    const { id, generation } = await seedRunning(h, wsA, { attempt: 2 });
    const before = await h.row(id);
    await expect(
      uow.run({ workspaceId: wsA }, async ({ recovery }) => {
        expect(
          await recovery.expireLease({
            versionId: id,
            observedGeneration: generation,
            leaseDurationMs,
          }),
        ).toEqual({ status: "parsing", attempt: 2, leaseGeneration: generation + 1 });
        throw new Error("forced failure after the compare-and-set");
      }),
    ).rejects.toThrow("forced failure");
    expect(await h.row(id)).toEqual(before);
  });

  it("undoes the bump, the transition and the outbox when the schedule step fails", async () => {
    const { id, generation } = await seedRunning(h, wsA);
    const before = await h.row(id);
    const outboxBefore = await h.outboxRows(id);
    const failing: RecoveryUnitOfWork = {
      run: (context, work, options) =>
        uow.run(
          context,
          ({ recovery, ingestion }) =>
            work({
              recovery,
              ingestion: {
                ...ingestion,
                insertOutbox: () => Promise.reject(new Error("forced outbox failure")),
              },
            }),
          options,
        ),
    };
    await expect(recover(failing, wsA, id, generation)).rejects.toThrow("forced outbox failure");
    expect(await h.row(id)).toEqual(before);
    expect(await h.outboxRows(id)).toEqual(outboxBefore);
  });
});

describe("discovery", () => {
  it("lists expired running versions oldest first, with no writes", async () => {
    const newest = await seedRunning(h, wsA, { ageMs: 400_000 });
    const oldest = await seedRunning(h, wsB, { status: "chunking", ageMs: 900_000 });
    const middle = await seedRunning(h, wsA, { ageMs: 600_000 });
    const live = await seedRunning(h, wsA, { ageMs: 10_000 });
    const waiting = await h.seed(wsA);
    await h.fx.fixture.query(
      "update document_versions set updated_at = now() - interval '1 hour' where id = $1",
      [waiting],
    );
    const before = await h.row(oldest.id);

    const found = await h.worker.recoverySource.listExpiredLeases(1_000, leaseDurationMs);
    const mine = new Map(found.map((c, index) => [c.versionId, { ...c, index }]));
    const order = [oldest, middle, newest].map((v) => mine.get(v.id)?.index ?? -1);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(mine.get(oldest.id)).toMatchObject({ workspaceId: wsB, observedGeneration: 1 });
    expect(mine.has(live.id)).toBe(false);
    expect(mine.has(waiting)).toBe(false);
    expect(await h.row(oldest.id)).toEqual(before);
  });

  // Documents the open hazard: discovery cannot see `documents`, so a deleted document's expired
  // version is listed on every sweep yet can never be re-queued. Terminalizing it is a hard
  // prerequisite of 5B.4 (recovery activation) and M1.7 (document deletion); drop this test then.
  it("still lists an expired version whose document is deleted", async () => {
    const { id } = await seedRunning(h, wsA);
    await h.fx.fixture.query(
      `update documents set deleted_at = now()
       where id = (select document_id from document_versions where id = $1)`,
      [id],
    );
    const found = await h.worker.recoverySource.listExpiredLeases(1_000, leaseDurationMs);
    expect(found.map((c) => c.versionId)).toContain(id);
  });

  it("respects the limit", async () => {
    await seedRunning(h, wsA);
    await seedRunning(h, wsA);
    expect(await h.worker.recoverySource.listExpiredLeases(2, leaseDurationMs)).toHaveLength(2);
  });
});

describe("worker grants and RLS", () => {
  const asWorker = async <T>(
    workspaceId: string,
    work: (q: pg.PoolClient) => Promise<T>,
  ): Promise<T> => {
    const client = await workerPool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
      return await work(client);
    } finally {
      await client.query("rollback");
      client.release();
    }
  };

  it("cannot read the storage key or error text that discovery must not touch", async () => {
    const client = await workerPool.connect();
    try {
      await expect(client.query("select storage_key from document_versions")).rejects.toMatchObject(
        { code: "42501" },
      );
      await expect(client.query("select error_code from document_versions")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      client.release();
    }
  });

  it("updates no row of another workspace even without the repository's predicate", async () => {
    const { id } = await seedRunning(h, wsA);
    const result = await asWorker(wsB, (q) =>
      q.query(
        "update document_versions set lease_generation = lease_generation + 1 where id = $1",
        [id],
      ),
    );
    expect(result.rowCount).toBe(0);
    const own = await asWorker(wsA, (q) =>
      q.query(
        "update document_versions set lease_generation = lease_generation + 1 where id = $1",
        [id],
      ),
    );
    expect(own.rowCount).toBe(1);
  });
});
