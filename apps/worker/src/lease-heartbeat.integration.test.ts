import { createIngestionHarness } from "@contextvault/db/testing/ingestion";
import type { DocumentVersionId, StageInput, StageRunner } from "@contextvault/domain";
import { afterAll, describe, expect, it, vi } from "vitest";
import { failStage, faultyUow, recordingStages } from "./ingestion-consumer-test-support";
import { withHeartbeat } from "./lease-heartbeat";

// Real PostgreSQL (worker role) on the isolated test stack. Time passes on the database clock: a
// stale lease is made by backdating `updated_at`, never by an application timestamp.
const h = await createIngestionHarness();
const { wsA } = h;
afterAll(() => h.close());

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const intervalMs = 40;
const backdate = (id: string) =>
  h.fx.fixture.query(
    "update document_versions set updated_at = now() - interval '10 minutes' where id = $1",
    [id],
  );

async function claimed(): Promise<{ id: DocumentVersionId; gen: number; input: StageInput }> {
  const id = await h.seed(wsA);
  const claim = await h.run(wsA, (r) => r.claim({ versionId: id }));
  if (claim === null) throw new Error("seed was not claimable");
  await backdate(id);
  const input: StageInput = {
    stage: "parsing",
    workspaceId: wsA,
    versionId: id,
    leaseGeneration: claim.leaseGeneration,
    signal: new AbortController().signal,
  };
  return { id, gen: claim.leaseGeneration, input };
}

const decorate = (
  stage: () => Promise<void>,
  uow = h.worker.unitOfWork,
  log = vi.fn<(entry: Record<string, unknown>) => void>(),
) => {
  const onLost = vi.fn();
  const inner: StageRunner = { run: stage };
  const runner = withHeartbeat(inner, { uow, intervalMs, beatTimeoutMs: 5_000, onLost, log });
  return { runner, onLost, log };
};
const ageSeconds = async (id: string): Promise<number> => {
  const { rows } = await h.fx.fixture.query<{ age: number }>(
    "select extract(epoch from now() - updated_at)::float8 as age from document_versions where id = $1",
    [id],
  );
  return rows[0]?.age ?? Number.NaN;
};

describe("lease heartbeat against PostgreSQL", () => {
  it("renews the lease of the owner on the database clock while a stage runs", async () => {
    const { id, gen, input } = await claimed();
    expect(await ageSeconds(id)).toBeGreaterThan(590);
    const { runner, onLost } = decorate(() => sleep(intervalMs * 4));
    await runner.run(input);
    expect(await ageSeconds(id)).toBeLessThan(60);
    expect(await h.row(id)).toMatchObject({ status: "parsing", lease_generation: gen });
    expect(onLost).not.toHaveBeenCalled();
  });

  it.each([
    ["claimed again by another owner", "update document_versions set lease_generation = 9"],
    ["moved on by a requeue", "update document_versions set status = 'queued'"],
  ])("reports loss once and extends nothing when the version was %s", async (_name, change) => {
    const { id, input } = await claimed();
    await h.fx.fixture.query(`${change} where id = $1`, [id]);
    const before = await h.row(id);
    const { runner, onLost } = decorate(() => sleep(intervalMs * 5));
    await runner.run(input);
    expect(onLost).toHaveBeenCalledExactlyOnceWith({
      versionId: id,
      leaseGeneration: input.leaseGeneration,
    });
    expect(await h.row(id)).toEqual(before);
    expect(await ageSeconds(id)).toBeGreaterThan(590);
  });

  it("survives a temporary database outage without losing ownership, and renews after it", async () => {
    const { id, input } = await claimed();
    const faulty = faultyUow(h.worker.unitOfWork, (call) => (call <= 2 ? "transient" : undefined));
    // The stage lasts until the heartbeat has recovered, so load cannot cut the outage short.
    const log = vi.fn<(entry: Record<string, unknown>) => void>();
    const { runner, onLost } = decorate(
      async () => {
        await expect.poll(() => log.mock.calls.length, { timeout: 10_000 }).toBe(2);
      },
      faulty.uow,
      log,
    );
    await runner.run(input);
    expect(onLost).not.toHaveBeenCalled();
    expect(faulty.calls()).toBeGreaterThan(2);
    expect(log.mock.calls.map(([{ code }]) => code)).toEqual([
      "INGESTION_HEARTBEAT_FAILED",
      "INGESTION_HEARTBEAT_RECOVERED",
    ]);
    expect(await ageSeconds(id)).toBeLessThan(60);
  });

  it("leaves no beat behind to race the completion that follows the stage", async () => {
    const { id, gen, input } = await claimed();
    const { runner, onLost } = decorate(() => sleep(intervalMs * 3 + 5));
    await runner.run(input);
    const moved = await h.run(wsA, (r) =>
      r.transition({ versionId: id, leaseGeneration: gen, from: "parsing", to: "chunking" }),
    );
    expect(moved).toBe(true);
    const settledRow = await h.row(id);
    await sleep(intervalMs * 4);
    expect(await h.row(id)).toEqual(settledRow);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("stops beating when the stage fails and keeps the stage's own error", async () => {
    const { id, input } = await claimed();
    const fake = recordingStages(failStage("parsing", "parse.bad", false));
    const { runner } = decorate(async () => {
      await sleep(intervalMs * 2);
      await fake.stages.run(input);
    });
    await expect(runner.run(input)).rejects.toMatchObject({ message: "parse.bad" });
    const after = await h.row(id);
    await sleep(intervalMs * 4);
    expect(await h.row(id)).toEqual(after);
  });
});
