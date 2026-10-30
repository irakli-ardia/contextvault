import { randomUUID } from "node:crypto";
import {
  dispatchOutbox,
  type JobQueue,
  parseDocumentVersionId,
  parseOutboxId,
} from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { createIngestionHarness, entryFor } from "./ingestion-test-support";
import { sqlState } from "./tenant-fixture";

// Outbox writes, targeted conflict handling, discovery and the starvation guard.
const h = await createIngestionHarness();
const { wsA, wsB, run, worker } = h;

afterAll(() => h.close());

describe("insertOutbox", () => {
  it("treats a second live entry for the same version as already covered", async () => {
    const id = await h.seed(wsA, { outboxDelayMs: null });
    const first = entryFor(wsA, id, 1_000);
    await run(wsA, (r) => r.insertOutbox(first));
    await run(wsA, (r) => r.insertOutbox(entryFor(wsA, id, 5_000)));
    const rows = await h.outboxRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, workspace_id: wsA, version_id: id });
    expect(rows[0]?.delay_ms).toBe(1_000);
  });

  it("inserts a new entry once the earlier one is dispatched", async () => {
    const id = await h.seed(wsA);
    const [first] = await h.outboxRows(id);
    if (first === undefined) throw new Error("seed has no outbox entry");
    await run(wsA, (r) => r.markDispatched(parseOutboxId(first.id)));
    await run(wsA, (r) => r.insertOutbox(entryFor(wsA, id, 5_000)));
    expect(await h.outboxRows(id)).toHaveLength(2);
  });

  it("does not hide unrelated integrity errors", async () => {
    const one = await h.seed(wsA, { outboxDelayMs: null });
    const two = await h.seed(wsA, { outboxDelayMs: null });
    const entry = entryFor(wsA, one);
    await run(wsA, (r) => r.insertOutbox(entry));
    // Same primary key on another version: a unique violation of a different index.
    expect(await sqlState(run(wsA, (r) => r.insertOutbox({ ...entry, versionId: two })))).toBe(
      "23505",
    );
    // A version that does not exist: a foreign-key violation.
    const ghost = parseDocumentVersionId(randomUUID());
    expect(await sqlState(run(wsA, (r) => r.insertOutbox(entryFor(wsA, ghost))))).toBe("23503");
    // Another workspace's version, and another workspace's context: policy denials.
    const foreign = await h.seed(wsB, { outboxDelayMs: null });
    expect(await sqlState(run(wsA, (r) => r.insertOutbox(entryFor(wsA, foreign))))).toBe("23503");
    expect(await sqlState(run(wsA, (r) => r.insertOutbox(entryFor(wsB, foreign))))).toBe("42501");
    expect(await h.outboxRows(two)).toHaveLength(0);
  });
});

describe("markDispatched and deferOutbox", () => {
  it("marks once, and only inside the asserted workspace", async () => {
    const id = await h.seed(wsA);
    const [row] = await h.outboxRows(id);
    const outboxId = parseOutboxId(row?.id ?? "");
    expect(await run(wsB, (r) => r.markDispatched(outboxId))).toBe(false);
    const wins = await Promise.all(
      Array.from({ length: 5 }, () => run(wsA, (r) => r.markDispatched(outboxId))),
    );
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it("defers an undispatched entry, not a dispatched or foreign one", async () => {
    const id = await h.seed(wsA);
    const [row] = await h.outboxRows(id);
    const outboxId = parseOutboxId(row?.id ?? "");
    expect(await run(wsB, (r) => r.deferOutbox(outboxId, 30_000))).toBe(false);
    expect(await run(wsA, (r) => r.deferOutbox(outboxId, 30_000))).toBe(true);
    const [deferred] = await h.outboxRows(id);
    expect(deferred?.available_at.getTime()).toBeGreaterThan(Date.now() + 25_000);
    expect(deferred?.available_at.getTime()).toBeLessThan(Date.now() + 35_000);
    await run(wsA, (r) => r.markDispatched(outboxId));
    expect(await run(wsA, (r) => r.deferOutbox(outboxId, 0))).toBe(false);
  });
});

describe("listDue", () => {
  it("lists every workspace's due entries oldest first, without future or dispatched ones", async () => {
    const early = await h.seed(wsA);
    const middle = await h.seed(wsB);
    const future = await h.seed(wsA, { outboxDelayMs: 99_000 });
    const done = await h.seed(wsA);
    const [doneRow] = await h.outboxRows(done);
    await run(wsA, (r) => r.markDispatched(parseOutboxId(doneRow?.id ?? "")));
    await h.fx.fixture.query(
      "update outbox set available_at = now() - interval '2 seconds' where version_id = $1",
      [early],
    );
    await h.fx.fixture.query(
      "update outbox set available_at = now() - interval '1 second' where version_id = $1",
      [middle],
    );

    // Real source, so it also sees other test files' rows: keep ours.
    const due = await worker.source.listDue(1_000);
    const mine = due.filter((e) => [early, middle, future, done].includes(e.versionId));
    expect(mine.map((e) => e.versionId)).toEqual([early, middle]);
    expect(mine.find((e) => e.versionId === middle)?.workspaceId).toBe(wsB);
    expect(await worker.source.listDue(1)).toHaveLength(1);
  });
});

describe("starvation", () => {
  it("a failing batch is deferred, so newer healthy work dispatches on the next poll", async () => {
    await h.drainOutbox();
    const poison = new Set<string>();
    for (let n = 0; n < 3; n += 1) poison.add(await h.seed(wsA));
    const healthy = await h.seed(wsA);
    // Oldest first: the poison rows head the queue, the healthy one waits behind them.
    for (const id of poison) await h.makeDue(id);
    const jobs: string[] = [];
    const queue: JobQueue = {
      enqueue: async (job) => {
        if (poison.has(job.versionId)) throw new Error("poison");
        jobs.push(job.versionId);
      },
    };
    const deps = { source: h.ownSource, queue, uow: worker.unitOfWork };

    const first = await dispatchOutbox(deps, 3);
    expect(first.dispatched).toBe(0);
    expect(first.failures).toHaveLength(3);
    const deferred = await h.ownSource.listDue(100);
    expect(deferred.some((e) => poison.has(e.versionId))).toBe(false);

    const second = await dispatchOutbox(deps, 3);
    expect(second).toMatchObject({ dispatched: 1, failures: [] });
    expect(jobs).toEqual([healthy]);

    for (const id of poison) await h.makeDue(id);
    expect((await dispatchOutbox(deps, 3)).failures).toHaveLength(3);
  });

  it("does not defer an entry whose enqueue succeeded but whose mark failed", async () => {
    await h.drainOutbox();
    const id = await h.seed(wsA);
    const queue: JobQueue = { enqueue: async () => undefined };
    const uow = { run: () => Promise.reject(new Error("connection lost")) };
    const result = await dispatchOutbox({ source: h.ownSource, queue, uow }, 10);
    expect(result.failures).toHaveLength(1);
    const [row] = await h.outboxRows(id);
    expect(row?.delay_ms).toBe(0);
    expect(row?.available_at.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
