import { randomUUID } from "node:crypto";
import {
  type DocumentVersionId,
  dispatchOutbox,
  type IngestionUnitOfWork,
  type JobQueue,
  settleFailure,
} from "@contextvault/domain";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createIngestionHarness } from "../../testing/ingestion-test-support";
import { waitUntilBlocked } from "../recovery/recovery-test-support";

// Lock order is version, then outbox. Each case holds one transaction open on a barrier and
// observes the other blocked in pg_locks, so nothing here sleeps to order the interleaving.
const h = await createIngestionHarness();
const { wsA, run, worker } = h;

afterAll(() => h.close());
beforeEach(() => h.drainOutbox());

const queue: JobQueue = { enqueue: async () => {} };
const dispatch = (uow: IngestionUnitOfWork) =>
  dispatchOutbox({ source: h.ownSource, queue, uow }, 100);
const claim = (versionId: DocumentVersionId) => run(wsA, (r) => r.claim({ versionId }));
const live = async (id: string) => (await h.outboxRows(id)).filter((e) => e.dispatched_at === null);

/** Keeps each transaction open after its work, until released. */
function gated() {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const uow: IngestionUnitOfWork = {
    run: (context, work, options) =>
      worker.unitOfWork.run(
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
  return { uow, entered: entered.promise, release: gate.resolve };
}

/**
 * A test-controlled transaction that holds the version's lock, as a claim or a redrive would.
 * `release` commits and is idempotent, so a `finally` can call it after an assertion threw.
 */
async function holdVersionLock(id: DocumentVersionId, insertDueOutbox: boolean) {
  const client = await h.fx.fixture.connect();
  let open = true;
  const release = async () => {
    if (!open) return;
    open = false;
    try {
      await client.query("commit");
    } finally {
      client.release();
    }
  };
  try {
    await client.query("begin");
    await client.query("select 1 from document_versions where id = $1 for no key update", [id]);
    if (insertDueOutbox) {
      await client.query(
        `insert into outbox (id, workspace_id, version_id, kind, available_at)
         values ($1, $2, $3, 'process_version', now())`,
        [randomUUID(), wsA, id],
      );
    }
  } catch (error) {
    open = false;
    await client.query("rollback").catch(() => undefined);
    client.release();
    throw error;
  }
  return release;
}

describe("claim racing with an outbox insert under the version lock", () => {
  it("a claim that waited on the version consumes the new entry, so the retry keeps its backoff", async () => {
    const id = await h.seed(wsA, { status: "queued", outboxDelayMs: null });
    const commit = await holdVersionLock(id, true);
    try {
      const claiming = claim(id);
      await waitUntilBlocked(h, id);
      await commit();
      expect(await claiming).toEqual({ leaseGeneration: 1, attempt: 1 });
    } finally {
      await commit();
    }

    const retry = { stage: "parsing", code: "storage.unavailable", retryable: true } as const;
    expect(
      await settleFailure(
        { uow: worker.unitOfWork, newId: randomUUID },
        { workspaceId: wsA, versionId: id, leaseGeneration: 1, failure: retry },
      ),
    ).toEqual({ outcome: "retry", delayMs: 5_000 });

    expect(await h.row(id)).toMatchObject({ status: "queued", attempt: 1, lease_generation: 1 });
    const [entry, ...others] = await live(id);
    expect(others).toHaveLength(0);
    expect(entry?.delay_ms).toBe(5_000);
    const { rows } = await h.fx.fixture.query<{ future: boolean }>(
      "select available_at > now() as future from outbox where id = $1",
      [entry?.id],
    );
    expect(rows[0]?.future).toBe(true);
    expect(await claim(id)).toBeNull();
  });
});

describe("dispatcher and claim contending on an uploaded version", () => {
  it("dispatcher holds both locks: the claim waits, then claims the queued version", async () => {
    const id = await h.seed(wsA);
    const dispatcher = gated();
    try {
      const dispatching = dispatch(dispatcher.uow);
      await dispatcher.entered;
      const claiming = claim(id);
      await waitUntilBlocked(h, id);
      dispatcher.release();
      expect(await dispatching).toMatchObject({ dispatched: 1, alreadyDispatched: 0 });
      expect(await claiming).toEqual({ leaseGeneration: 1, attempt: 1 });
    } finally {
      dispatcher.release();
    }
    expect(await h.row(id)).toMatchObject({ status: "parsing", attempt: 1, lease_generation: 1 });
    expect(await live(id)).toHaveLength(0);
  });

  it("claim holds both locks: the dispatcher waits, then finds the entry consumed", async () => {
    const id = await h.seed(wsA);
    const claimer = gated();
    try {
      const claiming = claimer.uow.run({ workspaceId: wsA }, ({ ingestion }) =>
        ingestion.claim({ versionId: id }),
      );
      await claimer.entered;
      const dispatching = dispatch(worker.unitOfWork);
      await waitUntilBlocked(h, id);
      claimer.release();
      expect(await claiming).toEqual({ leaseGeneration: 1, attempt: 1 });
      expect(await dispatching).toMatchObject({ dispatched: 0, alreadyDispatched: 1 });
    } finally {
      claimer.release();
    }
    expect(await h.row(id)).toMatchObject({ status: "parsing", attempt: 1, lease_generation: 1 });
    expect(await live(id)).toHaveLength(0);
  });

  it("a dispatcher waiting for the version holds no outbox lock", async () => {
    const id = await h.seed(wsA);
    const commit = await holdVersionLock(id, false);
    try {
      const dispatching = dispatch(worker.unitOfWork);
      await waitUntilBlocked(h, id);
      // With the lock order inverted the dispatcher would already hold the entry: NOWAIT fails.
      await h.fx.fixture.query(
        "select 1 from outbox where version_id = $1 and dispatched_at is null for update nowait",
        [id],
      );
      await commit();
      expect(await dispatching).toMatchObject({ dispatched: 1 });
    } finally {
      await commit();
    }
    expect(await h.row(id)).toMatchObject({ status: "queued", attempt: 0 });
  });
});
