import { describe, expect, it } from "vitest";
import { TransactionOutcomeUnknown } from "../kernel/errors";
import { dispatchOutbox, outboxJobId } from "./dispatch-outbox";
import { fakeIngestion } from "./fakes";

const ok = (dispatched: number, alreadyDispatched = 0) =>
  ({ dispatched, alreadyDispatched, failures: [], aborted: false }) as const;
const setup = (maxConsecutiveFailures = 3) => {
  const f = fakeIngestion();
  const deps = { source: f.source, queue: f.queue, uow: f.uow, maxConsecutiveFailures };
  return { f, run: (limit = 10, after?: string | null) => dispatchOutbox(deps, limit, after) };
};

describe("dispatchOutbox", () => {
  it("enqueues ids only under an outbox-<id> job, then marks and queues in one step", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "uploaded"));

    expect(await run()).toMatchObject(ok(1));
    expect([...f.jobs.keys()]).toEqual([`outbox-${entry.id}`]);
    expect(outboxJobId(entry.id)).not.toContain(":");
    expect(Object.keys(f.jobs.get(`outbox-${entry.id}`) ?? {}).sort()).toEqual([
      "jobId",
      "versionId",
      "workspaceId",
    ]);
    expect(f.outbox.get(entry.id)?.dispatchedAt).toEqual(f.clock.now);
    expect(f.versions.get(entry.versionId)?.status).toBe("queued");
  });

  it("does nothing a second time", async () => {
    const { f, run } = setup();
    f.addOutbox(1, f.addVersion(1, "uploaded"));
    await run();
    expect(await run()).toMatchObject(ok(0));
    expect(f.log).toEqual(["enqueue"]);
  });

  it("skips entries that are not due yet", async () => {
    const { f, run } = setup();
    f.addOutbox(1, f.addVersion(1, "queued"), 1);
    expect(await run()).toMatchObject(ok(0));
    expect(f.jobs.size).toBe(0);
  });

  it("rolls the mark back with the transition, then redelivers under the same job id", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "uploaded"));

    f.faults.transition = true;
    const result = await run();
    expect(result).toMatchObject({ dispatched: 0, failures: [{ outboxId: entry.id }] });
    expect(f.outbox.get(entry.id)?.dispatchedAt).toBeNull();
    expect(f.versions.get(entry.versionId)?.status).toBe("uploaded");

    f.faults.transition = false;
    expect(await run()).toMatchObject(ok(1));
    expect(f.log).toEqual(["enqueue", "enqueue"]);
    expect(f.jobs.size).toBe(1);
    expect(f.versions.get(entry.versionId)?.status).toBe("queued");
  });

  it("never defers an entry whose enqueue succeeded, so the next poll reconciles it", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "uploaded"));
    const dueAt = entry.availableAt;
    f.faults.transition = true;

    const result = await run();
    expect(result.failures).toEqual([{ outboxId: entry.id, error: new Error("connection lost") }]);
    expect(f.outbox.get(entry.id)?.entry.availableAt).toEqual(dueAt);
    expect(f.log).toEqual(["enqueue"]);
  });

  it("leaves entries unchanged after failed enqueues and retries them under the same job id", async () => {
    const { f, run } = setup();
    const a = f.addOutbox(1, f.addVersion(1, "uploaded"));
    f.faults.enqueue = true;

    const result = await run();
    expect(result.dispatched).toBe(0);
    expect(result.failures[0]?.error).toEqual(new Error("redis unavailable"));
    expect(f.outbox.get(a.id)).toMatchObject({ dispatchedAt: null, entry: a });
    expect(f.versions.get(a.versionId)?.status).toBe("uploaded");

    f.faults.enqueue = false;
    expect(await run()).toMatchObject(ok(1));
    expect([...f.jobs.keys()]).toEqual([`outbox-${a.id}`]);
  });

  it("stops a scan after the consecutive-failure bound and resumes after the last attempt", async () => {
    const { f, run } = setup();
    const entries = [1, 2, 3, 4, 5].map((n) => f.addOutbox(n, f.addVersion(n, "uploaded")));
    f.faults.enqueue = true;

    const first = await run(10);
    expect(first.aborted).toBe(true);
    expect(first.failures).toHaveLength(3);
    expect(f.log).toEqual(["enqueue", "enqueue", "enqueue"]);
    expect(first.next).toBe(entries[2]?.cursor);

    f.faults.enqueue = false;
    const second = await run(10, first.next);
    expect(second).toMatchObject({ ...ok(2), next: null });
    expect(f.outbox.get(entries[0]?.id ?? "")?.dispatchedAt).toBeNull();
  });

  it("a success resets the consecutive-failure count", async () => {
    const { f, run } = setup(2);
    const entries = [1, 2, 3, 4, 5].map((n) => f.addOutbox(n, f.addVersion(n, "uploaded")));
    for (const n of [0, 2, 4]) f.poisoned.add(entries[n]?.versionId ?? "");
    const result = await run();
    expect(result).toMatchObject({ dispatched: 2, aborted: false, next: null });
    expect(result.failures).toHaveLength(3);
  });

  it("a failing entry cannot keep later ones from being tried, and the cursor wraps", async () => {
    const { f, run } = setup();
    const poison = f.addOutbox(1, f.addVersion(1, "uploaded"));
    const later = [2, 3, 4].map((n) => f.addOutbox(n, f.addVersion(n, "uploaded")));
    f.poisoned.add(poison.versionId);

    const page1 = await run(2);
    expect(page1).toMatchObject({ dispatched: 1, next: later[0]?.cursor, aborted: false });
    const page2 = await run(2, page1.next);
    expect(page2.dispatched).toBe(2);
    // A full page cannot tell it is the last: the empty page after it wraps the cursor.
    const end = await run(2, page2.next);
    expect(end).toMatchObject({ dispatched: 0, next: null });
    // Wrapped: the poison entry is the only one left, and it is tried again.
    const page3 = await run(2, end.next);
    expect(page3).toMatchObject({ dispatched: 0, next: null });
    expect(page3.failures).toHaveLength(1);
    expect(f.outbox.get(poison.id)?.dispatchedAt).toBeNull();
  });

  it("revisits entries inserted behind the cursor once the scan wraps", async () => {
    const { f, run } = setup();
    f.addOutbox(2, f.addVersion(2, "uploaded"), 0);
    const first = await run(1);
    expect(first.next).not.toBeNull();
    f.advance(-60_000);
    const behind = f.addOutbox(1, f.addVersion(1, "uploaded"));
    f.advance(60_000);
    const second = await run(1, first.next);
    expect(second).toMatchObject({ dispatched: 0, next: null });
    expect(await run(1, second.next)).toMatchObject({ dispatched: 1 });
    expect(f.outbox.get(behind.id)?.dispatchedAt).not.toBeNull();
  });

  it("propagates a failing listing", async () => {
    const { f, run } = setup();
    f.faults.listDue = true;
    await expect(run()).rejects.toThrow("database unavailable");
  });

  it("reports an unknown commit outcome; the next poll finds it marked", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "uploaded"));
    f.faults.lostAck = true;

    const result = await run();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toBeInstanceOf(TransactionOutcomeUnknown);
    expect(f.outbox.get(entry.id)?.dispatchedAt).toEqual(f.clock.now);
    expect(f.versions.get(entry.versionId)?.status).toBe("queued");

    f.faults.lostAck = false;
    expect(await run()).toMatchObject(ok(0));
  });

  it("leaves a retry's already-queued version alone", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "queued", { attempt: 1 }));
    expect(await run()).toMatchObject(ok(1));
    expect(f.outbox.get(entry.id)?.dispatchedAt).toEqual(f.clock.now);
    expect(f.versions.get(entry.versionId)?.status).toBe("queued");
  });

  it("is a no-op when a concurrent dispatcher already finished the entry", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "uploaded"));
    await run();
    f.versions.set(entry.versionId, {
      id: entry.versionId,
      status: "parsing",
      leaseGeneration: 1,
      attempt: 1,
    });
    f.faults.listDispatched = true; // the stale listing still shows the entry
    expect(await run()).toMatchObject(ok(0, 1));
    expect(f.versions.get(entry.versionId)?.status).toBe("parsing");
  });

  it("honours the batch limit", async () => {
    const { f, run } = setup();
    for (const n of [1, 2, 3]) f.addOutbox(n, f.addVersion(n, "uploaded"));
    expect(await run(2)).toMatchObject(ok(2));
  });
});
