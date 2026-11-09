import { randomUUID } from "node:crypto";
import {
  type DocumentVersionId,
  dispatchOutbox,
  type JobQueue,
  maxAttempts,
  type OutboxEntry,
  parseOutboxId,
  redriveOrphan,
  settleFailure,
} from "@contextvault/domain";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gate, hour, seedOrphan } from "./orphan-test-support";
import { recover, seedRunning, waitUntilBlocked } from "./recovery-test-support";
import { createIngestionHarness } from "./testing/ingestion-test-support";

// Redrive against the dispatcher, a retry and expired-lease recovery, on lifecycle states those
// paths really produce. Each case names its serial order and the invariants it ends in.
const h = await createIngestionHarness();
const { wsA, worker } = h;
const orphans = worker.orphanUnitOfWork;

afterAll(() => h.close());
beforeEach(() => h.drainOutbox());

const live = async (id: string) => (await h.outboxRows(id)).filter((e) => e.dispatched_at === null);
const redrive = (versionId: DocumentVersionId) =>
  redriveOrphan({ uow: orphans, newId: randomUUID }, { workspaceId: wsA, versionId });
const retry = { stage: "parsing", code: "storage.unavailable", retryable: true } as const;

/** Records the order of enqueues; one version's enqueue can be held at a barrier. */
function recordingQueue(holdVersion?: DocumentVersionId) {
  const reached = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const jobIds: string[] = [];
  const queue: JobQueue = {
    enqueue: async (job) => {
      jobIds.push(job.jobId);
      if (job.versionId !== holdVersion) return;
      reached.resolve();
      await proceed.promise;
    },
  };
  return { queue, jobIds, reached: reached.promise, proceed: proceed.resolve };
}

describe("redrive racing with the dispatcher", () => {
  it("the enqueue is outside any transaction and before the mark: a redrive meanwhile skips", async () => {
    const id = await h.seed(wsA, { status: "queued" });
    const q = recordingQueue(id);
    try {
      const dispatching = dispatchOutbox(
        { source: h.ownSource, queue: q.queue, uow: worker.unitOfWork },
        100,
      );
      await q.reached;
      // Enqueue is in flight: no dispatcher transaction holds the version, and the entry is still live.
      await h.fx.fixture.query(
        "select 1 from document_versions where id = $1 for no key update nowait",
        [id],
      );
      expect(await live(id)).toHaveLength(1);
      expect(await redrive(id)).toEqual({ outcome: "skipped" });
      q.proceed();
      expect(await dispatching).toMatchObject({ dispatched: 1, alreadyDispatched: 0 });
    } finally {
      q.proceed();
    }
    expect(await live(id)).toEqual([]);
    expect(await h.outboxRows(id)).toHaveLength(1);
  });

  it.each(["uploaded", "queued"] as const)(
    "a %s version: the dispatcher holds the version lock, the redrive waits and finds the entry marked",
    async (status) => {
      const id = await h.seed(wsA, { status });
      const dispatcher = gate(worker.unitOfWork);
      const q = recordingQueue();
      try {
        const dispatching = dispatchOutbox(
          { source: h.ownSource, queue: q.queue, uow: dispatcher.uow },
          100,
        );
        await dispatcher.entered;
        const redriving = redrive(id);
        await waitUntilBlocked(h, id);
        dispatcher.release();
        expect(await dispatching).toMatchObject({ dispatched: 1 });
        // Serial order: dispatch, then redrive. The mark is fresh, so the cooldown holds.
        expect(await redriving).toEqual({ outcome: "skipped" });
      } finally {
        dispatcher.release();
      }
      expect(await h.row(id)).toMatchObject({ status: "queued", attempt: 0, lease_generation: 0 });
      expect(await h.outboxRows(id)).toHaveLength(1);
      expect(await live(id)).toEqual([]);
    },
  );

  it("a dispatcher working from a stale entry marks nothing of the redrive's, which then flows on", async () => {
    const id = await seedOrphan(h, wsA, {
      status: "uploaded",
      history: [{ createdAgoMs: 30 * hour, dispatchedAgoMs: 29 * hour }],
    });
    const [old] = await h.outboxRows(id);
    if (old === undefined) throw new Error("seed wrote no history");
    const stale: OutboxEntry = {
      id: parseOutboxId(old.id),
      workspaceId: wsA,
      versionId: id,
      availableAt: old.available_at,
      cursor: "",
    };
    expect(await redrive(id)).toEqual({ outcome: "redriven" });
    const [, fresh] = await h.outboxRows(id);

    const q = recordingQueue();
    const staleSource = { listDue: async () => [stale] };
    const late = await dispatchOutbox(
      { source: staleSource, queue: q.queue, uow: worker.unitOfWork },
      100,
    );
    expect(late).toMatchObject({ dispatched: 0, alreadyDispatched: 1 });
    expect(await h.outboxRows(id)).toEqual([old, fresh]);
    expect(await h.row(id)).toMatchObject({ status: "uploaded", attempt: 0 });

    // The real dispatcher then delivers the redrive's own entry; the orphan reaches `queued` and is claimed once.
    const real = recordingQueue();
    expect(
      await dispatchOutbox({ source: h.ownSource, queue: real.queue, uow: worker.unitOfWork }, 100),
    ).toMatchObject({ dispatched: 1 });
    expect(await h.row(id)).toMatchObject({ status: "queued", attempt: 0, lease_generation: 0 });
    expect(await h.run(wsA, (r) => r.claim({ versionId: id }))).toEqual({
      leaseGeneration: 1,
      attempt: 1,
    });
    expect(await live(id)).toEqual([]);
  });
});

describe("redrive racing with a retry insertion", () => {
  // Serial order: settleFailure, then redrive. While the retry is uncommitted the version is still
  // `parsing`, which is no orphan, so the redrive neither waits for it nor writes.
  it.each([
    { attempt: 1, delayMs: 5_000 },
    { attempt: 2, delayMs: 10_000 },
  ])(
    "attempt $attempt: the backoff entry of $delayMs ms is never bypassed",
    async ({ attempt, delayMs }) => {
      const { id, generation } = await seedRunning(h, wsA, { attempt });
      const settling = gate(worker.unitOfWork);
      try {
        const settled = settleFailure(
          { uow: settling.uow, newId: randomUUID },
          { workspaceId: wsA, versionId: id, leaseGeneration: generation, failure: retry },
        );
        await settling.entered;
        expect(await redrive(id)).toEqual({ outcome: "skipped" });
        expect(await h.outboxRows(id)).toHaveLength(1); // only the consumed entry: the retry's is uncommitted
        settling.release();
        expect(await settled).toEqual({ outcome: "retry", delayMs });
      } finally {
        settling.release();
      }
      const [entry] = await live(id);
      expect(entry?.delay_ms).toBe(delayMs);
      expect(await redrive(id)).toEqual({ outcome: "skipped" });
      expect(await live(id)).toEqual([entry]);
      expect(await h.row(id)).toMatchObject({
        status: "queued",
        attempt,
        lease_generation: generation,
      });
      expect(await h.run(wsA, (r) => r.claim({ versionId: id }))).toBeNull(); // still backing off
    },
  );
});

describe("redrive racing with expired-lease recovery", () => {
  // Serial order: recovery, then redrive. The expired version is `parsing` until recovery commits.
  it.each([
    { attempt: 1, delayMs: 5_000 },
    { attempt: 2, delayMs: 10_000 },
  ])(
    "attempt $attempt: one fenced re-queue with a $delayMs ms entry, untouched by the redrive",
    async ({ attempt, delayMs }) => {
      const { id, generation } = await seedRunning(h, wsA, { attempt });
      const recovering = gate(worker.recoveryUnitOfWork);
      try {
        const done = recover(recovering.uow, wsA, id, generation);
        await recovering.entered;
        expect(await redrive(id)).toEqual({ outcome: "skipped" });
        recovering.release();
        expect(await done).toEqual({ outcome: "retry", delayMs });
      } finally {
        recovering.release();
      }
      const [entry] = await live(id);
      expect(entry?.delay_ms).toBe(delayMs);
      expect(await redrive(id)).toEqual({ outcome: "skipped" });
      expect(await live(id)).toEqual([entry]);
      expect(await h.row(id)).toMatchObject({
        status: "queued",
        attempt,
        lease_generation: generation + 1,
      });
    },
  );

  it("an exhausted version ends failed and a redrive never resurrects it", async () => {
    const { id, generation } = await seedRunning(h, wsA, { attempt: maxAttempts });
    expect(await recover(worker.recoveryUnitOfWork, wsA, id, generation)).toEqual({
      outcome: "failed",
    });
    expect(await redrive(id)).toEqual({ outcome: "skipped" });
    expect(await h.row(id)).toMatchObject({ status: "failed", lease_generation: generation + 1 });
    expect(await live(id)).toEqual([]);
  });

  it("a recovery that observed the old generation, arriving during a redrive, is fenced out", async () => {
    const { id, generation } = await seedRunning(h, wsA);
    expect(await recover(worker.recoveryUnitOfWork, wsA, id, generation)).toMatchObject({
      outcome: "retry",
    });
    // The re-queued version's entry is dispatched long ago and its cooldown has passed: an orphan.
    await h.fx.fixture.query(
      "update outbox set dispatched_at = now() - interval '24 hours' where version_id = $1",
      [id],
    );
    await h.fx.fixture.query(
      "update document_versions set updated_at = now() - interval '24 hours' where id = $1",
      [id],
    );
    const redriving = gate(orphans);
    try {
      const done = redriveOrphan(
        { uow: redriving.uow, newId: randomUUID },
        { workspaceId: wsA, versionId: id },
      );
      await redriving.entered;
      // The version is `queued`, not running: the stale recovery matches nothing and does not wait.
      expect(await recover(worker.recoveryUnitOfWork, wsA, id, generation)).toEqual({
        outcome: "skipped",
      });
      redriving.release();
      expect(await done).toEqual({ outcome: "redriven" });
    } finally {
      redriving.release();
    }
    expect(await h.row(id)).toMatchObject({
      status: "queued",
      attempt: 1,
      lease_generation: generation + 1,
    });
    expect(await live(id)).toHaveLength(1);
  });
});
