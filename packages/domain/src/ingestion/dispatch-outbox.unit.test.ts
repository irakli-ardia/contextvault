import { describe, expect, it } from "vitest";
import { TransactionOutcomeUnknown } from "../kernel/errors";
import { dispatchOutbox, outboxJobId } from "./dispatch-outbox";
import { fakeIngestion } from "./fakes";

const ok = (dispatched: number, alreadyDispatched = 0) => ({
  dispatched,
  alreadyDispatched,
  failures: [],
});
const setup = () => {
  const f = fakeIngestion();
  const deps = { source: f.source, queue: f.queue, uow: f.uow };
  return { f, run: (limit = 10) => dispatchOutbox(deps, limit) };
};

describe("dispatchOutbox", () => {
  it("enqueues ids only under an outbox-<id> job, then marks and queues in one step", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "uploaded"));

    expect(await run()).toEqual(ok(1));
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
    expect(await run()).toEqual(ok(0));
    expect(f.log).toEqual(["enqueue"]);
  });

  it("skips entries that are not due yet", async () => {
    const { f, run } = setup();
    f.addOutbox(1, f.addVersion(1, "queued"), 1);
    expect(await run()).toEqual(ok(0));
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
    expect(await run()).toEqual(ok(1));
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

  it("reports every enqueue failure, leaves the entries undispatched and keeps going", async () => {
    const { f, run } = setup();
    const a = f.addOutbox(1, f.addVersion(1, "uploaded"));
    const b = f.addOutbox(2, f.addVersion(2, "uploaded"));
    f.faults.enqueue = true;

    const result = await run();
    expect(result.dispatched).toBe(0);
    expect(result.failures.map((x) => x.outboxId)).toEqual([a.id, b.id]);
    expect(result.failures[0]?.error).toEqual(new Error("redis unavailable"));
    expect(f.outbox.get(a.id)?.dispatchedAt).toBeNull();

    f.faults.enqueue = false;
    f.advance(30_000);
    expect(await run()).toEqual(ok(2));
  });

  it("defers an entry whose enqueue failed by 30 s so it cannot starve newer work", async () => {
    const { f, run } = setup();
    const poison = f.addOutbox(1, f.addVersion(1, "uploaded"));
    const healthy = f.addOutbox(2, f.addVersion(2, "uploaded"), 1);
    f.faults.enqueue = true;
    expect((await run(1)).failures).toHaveLength(1);
    expect(f.outbox.get(poison.id)?.entry.availableAt).toEqual(
      new Date(f.clock.now.getTime() + 30_000),
    );

    f.faults.enqueue = false;
    f.advance(1);
    expect(await run(1)).toEqual(ok(1));
    expect(f.outbox.get(healthy.id)?.dispatchedAt).toEqual(f.clock.now);
  });

  it("reports a failed deferral too", async () => {
    const { f, run } = setup();
    f.addOutbox(1, f.addVersion(1, "uploaded"));
    f.faults.enqueue = true;
    f.faults.deferOutbox = true;
    expect((await run()).failures).toHaveLength(2);
  });

  it("reports an unknown commit outcome without deferring; the next poll finds it marked", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "uploaded"));
    f.faults.lostAck = true;
    f.faults.deferOutbox = true; // a deferral attempt would surface as a second failure

    const result = await run();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toBeInstanceOf(TransactionOutcomeUnknown);
    expect(f.outbox.get(entry.id)?.dispatchedAt).toEqual(f.clock.now);
    expect(f.versions.get(entry.versionId)?.status).toBe("queued");

    f.faults.lostAck = false;
    expect(await run()).toEqual(ok(0));
  });

  it("leaves a retry's already-queued version alone", async () => {
    const { f, run } = setup();
    const entry = f.addOutbox(1, f.addVersion(1, "queued", { attempt: 1 }));
    expect(await run()).toEqual(ok(1));
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
    expect(await run()).toEqual(ok(0, 1));
    expect(f.versions.get(entry.versionId)?.status).toBe("parsing");
  });

  it("honours the batch limit", async () => {
    const { f, run } = setup();
    for (const n of [1, 2, 3]) f.addOutbox(n, f.addVersion(n, "uploaded"));
    expect(await run(2)).toEqual(ok(2));
  });
});
