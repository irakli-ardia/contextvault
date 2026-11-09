import { leaseDurationMs } from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { gated, recover, seedRunning, waitUntilBlocked } from "./recovery-test-support";
import { createIngestionHarness } from "./testing/ingestion-test-support";

// Races between expiry, heartbeat, a second recovery and a claim, ordered by explicit barriers:
// one transaction stays open while the other is observed blocked on the version's row lock.
const h = await createIngestionHarness();
const { wsA, run } = h;
const uow = h.worker.recoveryUnitOfWork;

afterAll(() => h.close());

const live = async (id: string) => (await h.outboxRows(id)).filter((e) => e.dispatched_at === null);

describe("heartbeat racing with expiry", () => {
  it("expiry commits first: the late heartbeat is fenced out", async () => {
    const { id, generation } = await seedRunning(h, wsA);
    const before = await h.row(id);
    const holder = gated(uow);
    const expiring = holder.uow.run({ workspaceId: wsA }, ({ recovery }) =>
      recovery.expireLease({ versionId: id, observedGeneration: generation, leaseDurationMs }),
    );
    await holder.entered;
    const beat = run(wsA, (r) => r.heartbeat({ versionId: id, leaseGeneration: generation }));
    await waitUntilBlocked(h, id);
    holder.release();
    expect(await expiring).toMatchObject({ leaseGeneration: generation + 1 });
    expect(await beat).toBe(false);
    expect(await h.row(id)).toMatchObject({
      lease_generation: generation + 1,
      updated_at: before.updated_at,
    });
  });

  it("heartbeat commits first: the lease is live again and expiry refuses", async () => {
    const { id, generation } = await seedRunning(h, wsA);
    const before = await h.row(id);
    const holder = gated(uow);
    const beating = holder.uow.run({ workspaceId: wsA }, ({ ingestion }) =>
      ingestion.heartbeat({ versionId: id, leaseGeneration: generation }),
    );
    await holder.entered;
    const expiring = uow.run({ workspaceId: wsA }, ({ recovery }) =>
      recovery.expireLease({ versionId: id, observedGeneration: generation, leaseDurationMs }),
    );
    await waitUntilBlocked(h, id);
    holder.release();
    expect(await beating).toBe(true);
    expect(await expiring).toBeNull();
    const after = await h.row(id);
    expect(after.lease_generation).toBe(generation);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});

describe("competing recoveries", () => {
  it("a second recovery waiting on the first finds the generation moved", async () => {
    const { id, generation } = await seedRunning(h, wsA);
    const first = gated(uow);
    const winner = recover(first.uow, wsA, id, generation);
    await first.entered;
    const loser = recover(uow, wsA, id, generation);
    await waitUntilBlocked(h, id);
    first.release();
    expect(await winner).toMatchObject({ outcome: "retry" });
    expect(await loser).toEqual({ outcome: "skipped" });
    expect(await h.row(id)).toMatchObject({ lease_generation: generation + 1, attempt: 1 });
    expect(await live(id)).toHaveLength(1);
  });

  it("two simultaneous calls: exactly one wins, one live outbox entry", async () => {
    const { id, generation } = await seedRunning(h, wsA);
    const outcomes = await Promise.all([
      recover(uow, wsA, id, generation),
      recover(uow, wsA, id, generation),
    ]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["retry", "skipped"]);
    expect(await h.row(id)).toMatchObject({ status: "queued", lease_generation: generation + 1 });
    expect(await live(id)).toHaveLength(1);
  });
});

describe("claim around an open recovery", () => {
  it("is refused during the open transaction and after the commit, leaving one live entry", async () => {
    const { id, generation } = await seedRunning(h, wsA);
    const recovering = gated(uow);
    const done = recover(recovering.uow, wsA, id, generation);
    await recovering.entered;
    // The uncommitted recovery is invisible: the version is still `parsing`, so the claim
    // does not wait on its lock and finds nothing to claim.
    expect(await run(wsA, (r) => r.claim({ versionId: id }))).toBeNull();
    recovering.release();
    expect(await done).toMatchObject({ outcome: "retry" });
    // Committed: `queued`, but the fresh entry is not due for 5 s.
    expect(await run(wsA, (r) => r.claim({ versionId: id }))).toBeNull();
    expect(await h.row(id)).toMatchObject({ status: "queued", lease_generation: generation + 1 });
    expect(await live(id)).toHaveLength(1);
  });
});
