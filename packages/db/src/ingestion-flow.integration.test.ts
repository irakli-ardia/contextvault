import { randomUUID } from "node:crypto";
import {
  type DocumentVersionId,
  dispatchOutbox,
  type IngestionUnitOfWork,
  type JobQueue,
  outboxJobId,
  parseOutboxId,
  settleFailure,
} from "@contextvault/domain";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createIngestionHarness } from "./ingestion-test-support";

// The real adapters end to end: dispatch, claim, retry with PostgreSQL-owned backoff, redelivery.
const h = await createIngestionHarness();
const { wsA, run, worker } = h;

afterAll(() => h.close());
beforeEach(() => h.drainOutbox());

// Like BullMQ's default retention: a job id, once added, is held for good and a second add of it
// does nothing. `added` lists the ids that really created a job.
const held = new Set<string>();
const added: string[] = [];
const queue: JobQueue = {
  enqueue: async (job) => {
    if (held.has(job.jobId)) return;
    held.add(job.jobId);
    added.push(job.jobId);
  },
};
const dispatchDeps = { source: h.ownSource, queue, uow: worker.unitOfWork };
const dispatch = () => dispatchOutbox(dispatchDeps, 100);
const settleDeps = { uow: worker.unitOfWork, newId: randomUUID };
const retryable = { stage: "parsing", code: "storage.unavailable", retryable: true } as const;
const claim = (versionId: DocumentVersionId) => run(wsA, (r) => r.claim({ versionId }));
const settle = (versionId: DocumentVersionId, leaseGeneration: number) =>
  settleFailure(settleDeps, { workspaceId: wsA, versionId, leaseGeneration, failure: retryable });
const liveEntry = async (versionId: DocumentVersionId) => {
  const live = (await h.outboxRows(versionId)).filter((r) => r.dispatched_at === null);
  expect(live).toHaveLength(1);
  return live[0] ?? never();
};
const never = (): never => {
  throw new Error("unreachable");
};

describe("ingestion flow", () => {
  it("retries with 5 s then 10 s backoff, refuses early redelivery, and fails after 3 attempts", async () => {
    const id = await h.seed(wsA);

    expect(await dispatch()).toMatchObject({ dispatched: 1 });
    expect(await h.row(id)).toMatchObject({ status: "queued", attempt: 0 });
    expect(await claim(id)).toEqual({ leaseGeneration: 1, attempt: 1 });

    // Attempt 1 fails: back to queued, a new entry due in 5 s of database time.
    expect(await settle(id, 1)).toEqual({ outcome: "retry", delayMs: 5_000 });
    const second = await liveEntry(id);
    expect(second.delay_ms).toBe(5_000);
    expect(await claim(id)).toBeNull();
    expect(await h.row(id)).toMatchObject({ status: "queued", attempt: 1, lease_generation: 1 });
    await dispatch();
    expect(held.has(outboxJobId(parseOutboxId(second.id)))).toBe(false);

    await h.makeDue(id);
    await dispatch();
    expect(held.has(outboxJobId(parseOutboxId(second.id)))).toBe(true);
    expect(await claim(id)).toEqual({ leaseGeneration: 2, attempt: 2 });

    // Attempt 2 fails: next entry due in 10 s.
    expect(await settle(id, 2)).toEqual({ outcome: "retry", delayMs: 10_000 });
    expect((await liveEntry(id)).delay_ms).toBe(10_000);
    expect(await claim(id)).toBeNull();
    await h.makeDue(id);
    await dispatch();
    expect(await claim(id)).toEqual({ leaseGeneration: 3, attempt: 3 });

    // Attempt 3 is the last: the failure is terminal and recorded.
    expect(await settle(id, 3)).toEqual({ outcome: "failed" });
    expect(await h.row(id)).toMatchObject({
      status: "failed",
      attempt: 3,
      error_code: "storage.unavailable",
      error_retryable: true,
    });
    expect(await claim(id)).toBeNull();
  });

  it("recovers a lost acknowledgement without stranding the document", async () => {
    const id = await h.seed(wsA);
    const [first] = await h.outboxRows(id);
    const firstJob = outboxJobId(parseOutboxId(first?.id ?? ""));
    let failMark = true;
    const uow: IngestionUnitOfWork = {
      run: (context, work, options) => {
        if (!failMark) return worker.unitOfWork.run(context, work, options);
        failMark = false;
        return Promise.reject(new Error("connection lost"));
      },
    };

    // The job is enqueued, then the marking transaction fails: the entry stays unchanged.
    const lost = await dispatchOutbox({ ...dispatchDeps, uow }, 100);
    expect(lost.failures).toHaveLength(1);
    expect(held.has(firstJob)).toBe(true);
    expect((await liveEntry(id)).available_at.getTime()).toBeLessThanOrEqual(Date.now());

    // The delivered job is claimed at once and consumes the entry.
    expect(await claim(id)).toEqual({ leaseGeneration: 1, attempt: 1 });
    expect((await h.outboxRows(id))[0]?.dispatched_at).not.toBeNull();

    // A retryable failure gets a fresh entry with its backoff, not the consumed one.
    expect(await settle(id, 1)).toEqual({ outcome: "retry", delayMs: 5_000 });
    const retry = await liveEntry(id);
    expect(retry.id).not.toBe(first?.id);
    expect(retry.delay_ms).toBe(5_000);
    expect(await claim(id)).toBeNull();

    // After the backoff the retry is added under a new id, though the first id is still held.
    await h.makeDue(id);
    expect(await dispatch()).toMatchObject({ failures: [] });
    expect(added).toContain(outboxJobId(parseOutboxId(retry.id)));
    expect(await h.row(id)).toMatchObject({ status: "queued", attempt: 1 });
    expect(await claim(id)).toEqual({ leaseGeneration: 2, attempt: 2 });
  });

  it("lets a redelivery claim when the entry is due but the mark was lost, and closes it", async () => {
    const id = await h.seed(wsA);
    expect(await claim(id)).not.toBeNull();
    // The claim consumed the entry, so the dispatcher no longer sees it and leaves the version be.
    expect(await dispatch()).toMatchObject({ dispatched: 0, alreadyDispatched: 0, failures: [] });
    expect(await h.row(id)).toMatchObject({ status: "parsing", lease_generation: 1, attempt: 1 });
    expect((await h.outboxRows(id))[0]?.dispatched_at).not.toBeNull();
  });

  it("gives exactly one winner among parallel deliveries, who spends one attempt", async () => {
    const id = await h.seed(wsA);
    const results = await Promise.all(Array.from({ length: 10 }, () => claim(id)));
    expect(results.filter((r) => r !== null)).toEqual([{ leaseGeneration: 1, attempt: 1 }]);
    expect(await h.row(id)).toMatchObject({ status: "parsing", lease_generation: 1, attempt: 1 });
  });

  it("keeps a dispatch racing a claim safe: no deadlock, one consumed entry, one attempt", async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => h.seed(wsA)));
    const [dispatched] = await Promise.all([dispatch(), ...ids.map(claim)]);
    expect(dispatched?.failures).toEqual([]);
    for (const id of ids) {
      expect(await h.row(id)).toMatchObject({ status: "parsing", lease_generation: 1, attempt: 1 });
      expect((await h.outboxRows(id)).every((r) => r.dispatched_at !== null)).toBe(true);
    }
  });

  it("makes a stale worker's failure a no-op after a newer claim", async () => {
    const id = await h.seed(wsA, { outboxDelayMs: null });
    await claim(id);
    await run(wsA, (r) =>
      r.transition({ versionId: id, leaseGeneration: 1, from: "parsing", to: "queued" }),
    );
    await claim(id);

    expect(await settle(id, 1)).toEqual({ outcome: "stale" });
    expect(await h.row(id)).toMatchObject({ status: "parsing", lease_generation: 2 });
    expect(await h.outboxRows(id)).toHaveLength(0);
  });

  it("covers a duplicate retry insertion with the pending entry instead of conflicting", async () => {
    const id = await h.seed(wsA);
    await dispatch();
    await claim(id);
    await settle(id, 1);
    const pending = await liveEntry(id);

    // The pending retry is still live; a duplicate settlement must find it covered, not conflict.
    await run(wsA, (r) =>
      r.insertOutbox({
        id: parseOutboxId(randomUUID()),
        workspaceId: wsA,
        versionId: id,
        delayMs: 5_000,
      }),
    );
    expect((await liveEntry(id)).id).toBe(pending.id);
  });
});
