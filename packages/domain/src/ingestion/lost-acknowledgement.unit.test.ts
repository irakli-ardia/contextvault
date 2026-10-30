import { describe, expect, it } from "vitest";
import { dispatchOutbox } from "./dispatch-outbox";
import { fakeIngestion, workspaceId } from "./fakes";
import { settleFailure } from "./settle-failure";

// The fake queue keeps every job id for good, like BullMQ keeps finished jobs by default: a second
// add of a delivered id does nothing, so only a fresh id can bring the document back.
describe("a lost acknowledgement between enqueue and mark", () => {
  it("never strands the document: the consumed entry is closed and the retry gets its own job", async () => {
    const f = fakeIngestion();
    const deps = { source: f.source, queue: f.queue, uow: f.uow };
    const id = f.addVersion(1, "uploaded");
    const first = f.addOutbox(1, id);

    f.faults.transition = true; // enqueue succeeds, the mark's transaction fails
    expect((await dispatchOutbox(deps, 10)).failures).toHaveLength(1);
    f.faults.transition = false;
    expect(f.outbox.get(first.id)).toMatchObject({ dispatchedAt: null, entry: first });

    const claimed = await f.uow.run({ workspaceId }, ({ ingestion }) =>
      ingestion.claim({ versionId: id }),
    );
    expect(claimed).toEqual({ leaseGeneration: 1, attempt: 1 });
    expect(f.outbox.get(first.id)?.dispatchedAt).not.toBeNull();

    const failed = await settleFailure(
      { uow: f.uow, newId: f.newId },
      {
        workspaceId,
        versionId: id,
        leaseGeneration: 1,
        failure: { stage: "parsing", code: "storage.unavailable", retryable: true },
      },
    );
    expect(failed).toEqual({ outcome: "retry", delayMs: 5_000 });
    const live = [...f.outbox.values()].filter((r) => !r.dispatchedAt);
    expect(live).toHaveLength(1);
    expect(live[0]?.entry.id).not.toBe(first.id);
    expect(live[0]?.entry.availableAt).toEqual(new Date(f.clock.now.getTime() + 5_000));

    // Backoff: neither the dispatcher nor an early delivery gets ahead of the schedule.
    expect(await dispatchOutbox(deps, 10)).toMatchObject({ dispatched: 0 });
    expect(
      await f.uow.run({ workspaceId }, (r) => r.ingestion.claim({ versionId: id })),
    ).toBeNull();
    expect(f.versions.get(id)).toMatchObject({ status: "queued", attempt: 1 });

    f.advance(5_000);
    expect(await dispatchOutbox(deps, 10)).toMatchObject({ dispatched: 1, failures: [] });
    expect(f.jobs.size).toBe(2); // the retained first id did not swallow the retry's add
    const retried = await f.uow.run({ workspaceId }, (r) => r.ingestion.claim({ versionId: id }));
    expect(retried).toEqual({ leaseGeneration: 2, attempt: 2 });
  });

  it("does not spend an attempt on a duplicate delivery", async () => {
    const f = fakeIngestion();
    const id = f.addVersion(1, "uploaded");
    f.addOutbox(1, id);
    const claim = () => f.uow.run({ workspaceId }, (r) => r.ingestion.claim({ versionId: id }));

    expect(await claim()).toEqual({ leaseGeneration: 1, attempt: 1 });
    expect(await claim()).toBeNull();
    expect(f.versions.get(id)).toMatchObject({ status: "parsing", attempt: 1, leaseGeneration: 1 });
  });
});
