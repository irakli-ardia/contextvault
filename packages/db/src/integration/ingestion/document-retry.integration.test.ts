import { randomUUID } from "node:crypto";
import { parseDocumentId, parseOutboxId, WorkspaceAccessDenied } from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { seedDoc, softDelete } from "../../testing/deletion-test-support";
import { createIngestionHarness } from "../../testing/ingestion-test-support";
import { liveEntries, retry, seedFailed } from "../../testing/retry-test-support";

// The retry command against the real database as the application role: the transition, its
// outbox entry and every state it must refuse.
const h = await createIngestionHarness();
const { wsA, wsB, userA, userB, run } = h;
afterAll(() => h.close());

describe("retry of a failed version", () => {
  it("queues it with a fresh budget, a bumped generation, no failure and one live entry", async () => {
    const doc = await seedFailed(h, wsA, { attempt: 3 });
    expect(await retry(h, userA, wsA, doc.documentId)).toBe("retried");
    expect(await h.row(doc.versionId)).toMatchObject({
      status: "queued",
      attempt: 0,
      lease_generation: 4,
      error_stage: null,
      error_code: null,
      error_retryable: null,
    });
    expect(await liveEntries(h, doc.versionId)).toBe(1);
  });

  it("is claimable again after the budget was spent, for a full set of attempts", async () => {
    const doc = await seedFailed(h, wsA, { attempt: 3, code: "handoff.missing" });
    await retry(h, userA, wsA, doc.documentId);
    const claimed = await run(wsA, (r) => r.claim({ versionId: doc.versionId }));
    expect(claimed).toEqual({ leaseGeneration: 5, attempt: 1 });
    expect(await liveEntries(h, doc.versionId)).toBe(0);
  });

  it("fences a writer still holding the generation of the failed attempt", async () => {
    const doc = await seedFailed(h, wsA);
    await retry(h, userA, wsA, doc.documentId);
    await run(wsA, (r) => r.claim({ versionId: doc.versionId }));
    const stale = await run(wsA, (r) =>
      r.transition({
        versionId: doc.versionId,
        leaseGeneration: doc.generation,
        from: "parsing",
        to: "chunking",
      }),
    );
    expect(stale).toBe(false);
    expect(await h.row(doc.versionId)).toMatchObject({ status: "parsing" });
  });

  it("refuses a repeat: the second request finds the version queued, one entry stays", async () => {
    const doc = await seedFailed(h, wsA);
    expect(await retry(h, userA, wsA, doc.documentId)).toBe("retried");
    expect(await retry(h, userA, wsA, doc.documentId)).toBe("not_retryable");
    expect(await liveEntries(h, doc.versionId)).toBe(1);
    expect(await h.row(doc.versionId)).toMatchObject({ status: "queued", lease_generation: 4 });
  });
});

describe("refusals change nothing", () => {
  const unchanged = async (doc: Awaited<ReturnType<typeof seedFailed>>, before: object) => {
    expect(await h.row(doc.versionId)).toMatchObject(before);
    expect(await liveEntries(h, doc.versionId)).toBe(0);
  };

  it.each([
    ["not retryable", { retryable: false }],
    ["no verdict recorded", { retryable: null }],
    ["closed by a deletion", { retryable: false, code: "document.deleted" }],
  ])("a failure that is %s", async (_name, options) => {
    const doc = await seedFailed(h, wsA, options);
    expect(await retry(h, userA, wsA, doc.documentId)).toBe("not_retryable");
    await unchanged(doc, { status: "failed", attempt: 3, lease_generation: 3 });
  });

  it.each(["queued", "parsing", "chunking", "ready"] as const)("a %s version", async (status) => {
    const doc = await seedDoc(h, wsA, status);
    await h.fx.fixture.query("update outbox set dispatched_at = now() where version_id = $1", [
      doc.versionId,
    ]);
    expect(await retry(h, userA, wsA, doc.documentId)).toBe("not_retryable");
    expect((await h.row(doc.versionId)).status).toBe(status);
  });

  it("an older failed version when a newer one exists", async () => {
    const doc = await seedFailed(h, wsA);
    const newer = randomUUID();
    await h.fx.fixture.query(
      `insert into document_versions (id, document_id, workspace_id, version_no, storage_key, status)
       values ($1, $2, $3, 2, $4, 'ready')`,
      [newer, doc.documentId, wsA, `ws/${wsA}/doc/${doc.documentId}/v/${newer}`],
    );
    expect(await retry(h, userA, wsA, doc.documentId)).toBe("not_retryable");
    await unchanged(doc, { status: "failed" });
  });

  it("a deleted document, however its version failed", async () => {
    const doc = await seedFailed(h, wsA);
    await softDelete(h, userA, wsA, doc.documentId);
    expect(await retry(h, userA, wsA, doc.documentId)).toBe("not_found");
    expect(await h.row(doc.versionId)).toMatchObject({ status: "failed" });
    expect(await liveEntries(h, doc.versionId)).toBe(0);
  });

  it("an absent document, and another workspace's document", async () => {
    const doc = await seedFailed(h, wsA);
    expect(await retry(h, userA, wsA, parseDocumentId(randomUUID()))).toBe("not_found");
    expect(await retry(h, userB, wsB, doc.documentId)).toBe("not_found");
    // A non-member never reaches the repository: the unit of work refuses the context itself.
    await expect(retry(h, userB, wsA, doc.documentId)).rejects.toThrow(WorkspaceAccessDenied);
    await unchanged(doc, { status: "failed", attempt: 3 });
  });
});

describe("atomicity", () => {
  it("a failing outbox insert rolls the version back to failed", async () => {
    const doc = await seedFailed(h, wsA);
    const taken = randomUUID();
    await h.fx.fixture.query(
      "insert into outbox (id, workspace_id, version_id, kind, dispatched_at) values ($1, $2, $3, 'process_version', now())",
      [taken, wsA, doc.versionId],
    );
    await expect(retry(h, userA, wsA, doc.documentId, parseOutboxId(taken))).rejects.toThrow();
    expect(await h.row(doc.versionId)).toMatchObject({
      status: "failed",
      attempt: 3,
      lease_generation: 3,
      error_retryable: true,
    });
    expect(await liveEntries(h, doc.versionId)).toBe(0);
  });
});
