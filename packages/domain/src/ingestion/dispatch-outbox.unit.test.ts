import { describe, expect, it } from "vitest";
import { TransactionOutcomeUnknown } from "../kernel/errors";
import { dispatchOutbox, outboxJobId } from "./dispatch-outbox";
import { fakeIngestion } from "./fakes";

const now = new Date("2026-10-30T12:00:00Z");
const ok = (dispatched: number, alreadyDispatched = 0) => ({
  dispatched,
  alreadyDispatched,
  failures: [],
});
const setup = () => {
  const f = fakeIngestion();
  const deps = { source: f.source, queue: f.queue, uow: f.uow };
  return { f, run: () => dispatchOutbox(deps, now, 10) };
};

describe("dispatchOutbox", () => {
  it("enqueues ids only under an outbox-<id> job, then marks and queues in one step", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "uploaded"), now);

    expect(await run()).toEqual(ok(1));
    expect([...f.jobs.keys()]).toEqual([`outbox-${entry.id}`]);
    expect(outboxJobId(entry.id)).not.toContain(":");
    expect(Object.keys(f.jobs.get(`outbox-${entry.id}`) ?? {}).sort()).toEqual([
      "jobId",
      "versionId",
      "workspaceId",
    ]);
    expect(f.outbox.get(entry.id)?.dispatchedAt).toEqual(now);
    expect(f.versions.get(entry.versionId)?.status).toBe("queued");
  });

  it("does nothing a second time", async () => {
    const { f, run } = setup();
    f.addOutbox(1, f.addVersion(1, "uploaded"), now);
    await run();
    expect(await run()).toEqual(ok(0));
    expect(f.log).toEqual(["enqueue"]);
  });

  it("skips entries that are not due yet", async () => {
    const { f, run } = setup();
    f.addOutbox(1, f.addVersion(1, "queued"), new Date(now.getTime() + 1));
    expect(await run()).toEqual(ok(0));
    expect(f.jobs.size).toBe(0);
  });

  it("rolls the mark back with the transition, then redelivers under the same job id", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "uploaded"), now);

    f.faults.transition = true;
    const result = await run();
    expect(result).toMatchObject({ dispatched: 0, failures: [{ outboxId: entry.id }] });
    expect(f.outbox.get(entry.id)?.dispatchedAt).toBeNull();
    expect(f.versions.get(entry.versionId)?.status).toBe("uploaded");

    f.faults.transition = false;
    expect(await run()).toEqual(ok(1));
    expect(f.log).toEqual(["enqueue", "enqueue"]);
    expect(f.jobs.size).toBe(1);
    expect(f.versions.get(entry.versionId)?.status).toBe("queued");
  });

  it("reports every failure, leaves the entry undispatched and keeps going", async () => {
    const { f, run } = setup();
    const a = f.addOutbox(1, f.addVersion(1, "uploaded"), now);
    const b = f.addOutbox(2, f.addVersion(2, "uploaded"), now);
    f.faults.enqueue = true;

    const result = await run();
    expect(result.dispatched).toBe(0);
    expect(result.failures.map((x) => x.outboxId)).toEqual([a.id, b.id]);
    expect(result.failures[0]?.error).toEqual(new Error("redis unavailable"));
    expect(f.outbox.get(a.id)?.dispatchedAt).toBeNull();

    f.faults.enqueue = false;
    expect(await run()).toEqual(ok(2));
  });

  it("reports an unknown commit outcome, and the next poll finds the entry already marked", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "uploaded"), now);
    f.faults.lostAck = true;

    const result = await run();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toBeInstanceOf(TransactionOutcomeUnknown);
    expect(f.outbox.get(entry.id)?.dispatchedAt).toEqual(now);
    expect(f.versions.get(entry.versionId)?.status).toBe("queued");

    f.faults.lostAck = false;
    expect(await run()).toEqual(ok(0));
  });

  it("leaves a retry's already-queued version alone", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "queued", { attempt: 1 }), now);
    expect(await run()).toEqual(ok(1));
    expect(f.outbox.get(entry.id)?.dispatchedAt).toEqual(now);
    expect(f.versions.get(entry.versionId)?.status).toBe("queued");
  });

  it("is a no-op when a concurrent dispatcher already finished the entry", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "uploaded"), now);
    await run();
    f.versions.set(entry.versionId, {
      id: entry.versionId,
      status: "parsing",
      leaseGeneration: 1,
      attempt: 1,
    });
    f.faults.listDispatched = true; // the stale listing still shows the entry
    expect(await run()).toEqual(ok(0, 1));
    expect(f.versions.get(entry.versionId)?.status).toBe("parsing");
  });

  it("honours the batch limit", async () => {
    const { f } = setup();
    for (const n of [1, 2, 3]) f.addOutbox(n, f.addVersion(n, "uploaded"), now);
    const deps = { source: f.source, queue: f.queue, uow: f.uow };
    expect(await dispatchOutbox(deps, now, 2)).toEqual(ok(2));
  });
});
