import {
  type DocumentVersionId,
  parseOutboxId,
  type VersionStatus,
  type WorkspaceId,
} from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { createIngestionHarness } from "./ingestion-test-support";

// Claim and the fenced compare-and-set steps, through the worker role against real PostgreSQL.
const h = await createIngestionHarness();
const { wsA, wsB, run } = h;

afterAll(() => h.close());

type Target = "queued" | "chunking" | "processed";

const claim = (versionId: DocumentVersionId, ws: WorkspaceId = wsA) =>
  run(ws, (r) => r.claim({ versionId }));
const step = (
  versionId: DocumentVersionId,
  leaseGeneration: number,
  from: VersionStatus,
  to: Target,
  ws: WorkspaceId = wsA,
) => run(ws, (r) => r.transition({ versionId, leaseGeneration, from, to }));
const beat = (versionId: DocumentVersionId, leaseGeneration: number, ws: WorkspaceId = wsA) =>
  run(ws, (r) => r.heartbeat({ versionId, leaseGeneration }));

describe("claim", () => {
  it("claims a first delivery: parsing, generation 1, attempt 1", async () => {
    const id = await h.seed(wsA);
    expect(await claim(id)).toEqual({ leaseGeneration: 1, attempt: 1 });
    expect(await h.row(id)).toMatchObject({ status: "parsing", lease_generation: 1, attempt: 1 });
  });

  it("claims an uploaded version that has no outbox entry (recovery)", async () => {
    const id = await h.seed(wsA, { outboxDelayMs: null });
    expect(await claim(id)).toEqual({ leaseGeneration: 1, attempt: 1 });
  });

  it("claims while the due entry is not yet marked (lost acknowledgement)", async () => {
    const id = await h.seed(wsA);
    expect(await claim(id)).not.toBeNull();
  });

  it("closes the consumed entry, and a refused claim leaves it live", async () => {
    const id = await h.seed(wsA);
    const [entry] = await h.outboxRows(id);
    expect(await claim(id)).not.toBeNull();
    expect((await h.outboxRows(id))[0]?.dispatched_at).not.toBeNull();
    expect((await h.outboxRows(id))[0]?.id).toBe(entry?.id);

    const duplicate = await h.seed(wsA);
    await h.fx.fixture.query("update document_versions set status = 'parsing' where id = $1", [
      duplicate,
    ]);
    expect(await claim(duplicate)).toBeNull();
    expect((await h.outboxRows(duplicate))[0]?.dispatched_at).toBeNull();

    const spent = await h.seed(wsA, { status: "queued", attempt: 3 });
    expect(await claim(spent)).toBeNull();
    expect((await h.outboxRows(spent))[0]?.dispatched_at).toBeNull();
  });

  it("refuses a duplicate delivery without consuming an attempt", async () => {
    const id = await h.seed(wsA);
    await claim(id);
    expect(await claim(id)).toBeNull();
    expect(await h.row(id)).toMatchObject({ status: "parsing", lease_generation: 1, attempt: 1 });
  });

  it.each(["parsing", "chunking", "processed", "failed"] as const)("refuses %s", async (status) => {
    const id = await h.seed(wsA, { status, attempt: 1 });
    expect(await claim(id)).toBeNull();
    expect(await h.row(id)).toMatchObject({ status, attempt: 1, lease_generation: 0 });
  });

  it("refuses when the attempts are spent", async () => {
    const id = await h.seed(wsA, { status: "queued", attempt: 3, outboxDelayMs: null });
    expect(await claim(id)).toBeNull();
  });

  it("refuses a deleted document and another workspace's version", async () => {
    const deleted = await h.seed(wsA);
    await h.fx.fixture.query(
      `update documents set deleted_at = now()
       where id = (select document_id from document_versions where id = $1)`,
      [deleted],
    );
    expect(await claim(deleted)).toBeNull();

    const foreign = await h.seed(wsB);
    expect(await claim(foreign, wsA)).toBeNull();
    expect(await h.row(foreign)).toMatchObject({ status: "uploaded", attempt: 0 });
  });
});

describe("retry eligibility at claim", () => {
  const retrying = () => h.seed(wsA, { status: "queued", attempt: 1, outboxDelayMs: 5_000 });

  it("refuses an early redelivery and leaves attempt, generation and entry untouched", async () => {
    const id = await retrying();
    expect(await claim(id)).toBeNull();
    expect(await h.row(id)).toMatchObject({ status: "queued", attempt: 1, lease_generation: 0 });
    expect((await h.outboxRows(id))[0]?.dispatched_at).toBeNull();
  });

  it("claims once the scheduled time has arrived on the database clock", async () => {
    const id = await retrying();
    await h.makeDue(id);
    expect(await claim(id)).toEqual({ leaseGeneration: 1, attempt: 2 });
  });

  it("is no longer held back once the entry is dispatched", async () => {
    const id = await retrying();
    const [entry] = await h.outboxRows(id);
    if (entry === undefined) throw new Error("seed has no outbox entry");
    await run(wsA, (r) => r.markDispatched(parseOutboxId(entry.id)));
    expect(await claim(id)).not.toBeNull();
  });

  it("is not held back by another version's schedule", async () => {
    await retrying();
    const other = await h.seed(wsA, { outboxDelayMs: null });
    expect(await claim(other)).not.toBeNull();
  });

  it("does not close another version's entry or another workspace's", async () => {
    const mine = await h.seed(wsA);
    const sibling = await h.seed(wsA);
    const foreign = await h.seed(wsB);
    await claim(mine);
    expect((await h.outboxRows(sibling))[0]?.dispatched_at).toBeNull();
    expect((await h.outboxRows(foreign))[0]?.dispatched_at).toBeNull();
  });
});

describe("fenced steps", () => {
  const running = async () => {
    const id = await h.seed(wsA);
    const claimed = await claim(id);
    if (claimed === null) throw new Error("seed was not claimable");
    return { id, gen: claimed.leaseGeneration };
  };

  it("advances parsing to chunking to processed with the claimed generation", async () => {
    const { id, gen } = await running();
    expect(await step(id, gen, "parsing", "chunking")).toBe(true);
    expect(await step(id, gen, "chunking", "processed")).toBe(true);
    expect(await h.row(id)).toMatchObject({ status: "processed", lease_generation: gen });
  });

  it("refuses a stale generation, a wrong source status and another workspace", async () => {
    const { id, gen } = await running();
    expect(await step(id, gen + 1, "parsing", "chunking")).toBe(false);
    expect(await step(id, gen, "chunking", "processed")).toBe(false);
    expect(await step(id, gen, "parsing", "chunking", wsB)).toBe(false);
    expect(await h.row(id)).toMatchObject({ status: "parsing" });
  });

  it("rejects an illegal transition before touching the row", async () => {
    const { id, gen } = await running();
    await expect(step(id, gen, "parsing", "processed")).rejects.toThrow("Illegal transition");
    expect(await h.row(id)).toMatchObject({ status: "parsing" });
  });

  it("fences a worker whose lease was superseded by a newer claim", async () => {
    const { id, gen } = await running();
    expect(await step(id, gen, "parsing", "queued")).toBe(true);
    expect(await claim(id)).toEqual({ leaseGeneration: gen + 1, attempt: 2 });
    expect(await step(id, gen, "parsing", "chunking")).toBe(false);
    expect(await beat(id, gen)).toBe(false);
    expect(await h.row(id)).toMatchObject({ status: "parsing", lease_generation: gen + 1 });
  });

  it("renews the lease for the owner only, and only while running", async () => {
    const { id, gen } = await running();
    const before = (await h.row(id)).updated_at;
    expect(await beat(id, gen)).toBe(true);
    expect((await h.row(id)).updated_at.getTime()).toBeGreaterThan(before.getTime());
    expect(await beat(id, gen + 1)).toBe(false);
    expect(await beat(id, gen, wsB)).toBe(false);
    await step(id, gen, "parsing", "chunking");
    await step(id, gen, "chunking", "processed");
    expect(await beat(id, gen)).toBe(false);
  });

  it("records a failure with the stage and code, once, for the owner", async () => {
    const { id, gen } = await running();
    const failure = { stage: "parsing", code: "parse.corrupt", retryable: false } as const;
    const fail = (leaseGeneration: number) =>
      run(wsA, (r) => r.failVersion({ versionId: id, leaseGeneration, from: "parsing", failure }));
    expect(await fail(gen + 1)).toBe(false);
    expect(await fail(gen)).toBe(true);
    expect(await fail(gen)).toBe(false);
    expect(await h.row(id)).toMatchObject({
      status: "failed",
      error_stage: "parsing",
      error_code: "parse.corrupt",
      error_retryable: false,
    });
  });
});
