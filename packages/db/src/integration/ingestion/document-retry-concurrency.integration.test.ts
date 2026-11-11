import { afterAll, describe, expect, it } from "vitest";
import {
  documentRow,
  seedDoc,
  softDelete,
  waitUntilDocumentBlocked,
} from "../../testing/deletion-test-support";
import { createIngestionHarness } from "../../testing/ingestion-test-support";
import { liveEntries, newOutboxId, retry, seedFailed } from "../../testing/retry-test-support";

// Retry and delete lock the document row first, then the version: they serialize and never
// deadlock. Each case holds one transaction open on a barrier and watches the other wait.
const h = await createIngestionHarness();
const { wsA, userA, run } = h;
afterAll(() => h.close());

describe("retry and delete", () => {
  it("a retry that waits for an uncommitted delete finds the document deleted", async () => {
    const doc = await seedFailed(h, wsA);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const deleting = h.fx.persistence.unitOfWork.run(
      { userId: userA, workspaceId: wsA },
      async (r) => {
        const outcome = await r.documentDeletion.softDelete(wsA, doc.documentId);
        entered.resolve();
        await gate.promise;
        return outcome;
      },
    );
    await entered.promise;
    const retrying = retry(h, userA, wsA, doc.documentId);
    await waitUntilDocumentBlocked(h, doc.documentId);
    gate.resolve();

    expect(await deleting).toBe("deleted");
    expect(await retrying).toBe("not_found");
    expect(await liveEntries(h, doc.versionId)).toBe(0);
    expect(await h.row(doc.versionId)).toMatchObject({ status: "failed", attempt: 3 });
  });

  it("a delete that waits for an uncommitted retry closes the queued version it made", async () => {
    const doc = await seedFailed(h, wsA);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const retrying = h.fx.persistence.unitOfWork.run(
      { userId: userA, workspaceId: wsA },
      async (r) => {
        const outcome = await r.documentRetry.retry(wsA, doc.documentId, newOutboxId());
        entered.resolve();
        await gate.promise;
        return outcome;
      },
    );
    await entered.promise;
    const deleting = softDelete(h, userA, wsA, doc.documentId);
    await waitUntilDocumentBlocked(h, doc.documentId);
    gate.resolve();

    expect(await retrying).toBe("retried");
    expect(await deleting).toBe("deleted");
    expect(await h.row(doc.versionId)).toMatchObject({
      status: "failed",
      error_code: "document.deleted",
      error_retryable: false,
    });
    expect((await documentRow(h, doc.documentId)).deleted_at).toBeInstanceOf(Date);
    // The entry the retry wrote stays live, but a claim refuses the closed version of a deleted document.
    expect(await liveEntries(h, doc.versionId)).toBe(1);
    expect(await run(wsA, (r) => r.claim({ versionId: doc.versionId }))).toBeNull();
  });

  it("racing repeatedly never deadlocks and always ends consistent", async () => {
    for (let i = 0; i < 8; i++) {
      const doc = await seedFailed(h, wsA);
      const [retried, deleted] = await Promise.allSettled([
        retry(h, userA, wsA, doc.documentId),
        softDelete(h, userA, wsA, doc.documentId),
      ]);
      expect(retried.status).toBe("fulfilled");
      expect(deleted.status).toBe("fulfilled");
      expect((await documentRow(h, doc.documentId)).deleted_at).toBeInstanceOf(Date);
      expect(await h.row(doc.versionId)).toMatchObject({
        status: "failed",
        error_code: expect.stringMatching(/^(document\.deleted|storage\.unavailable)$/),
      });
      expect(await run(wsA, (r) => r.claim({ versionId: doc.versionId }))).toBeNull();
    }
  });
});

describe("two retries", () => {
  it("racing enqueue exactly once", async () => {
    for (let i = 0; i < 6; i++) {
      const doc = await seedFailed(h, wsA);
      const outcomes = await Promise.all([
        retry(h, userA, wsA, doc.documentId),
        retry(h, userA, wsA, doc.documentId),
        retry(h, userA, wsA, doc.documentId),
      ]);
      expect(outcomes.filter((o) => o === "retried")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "not_retryable")).toHaveLength(2);
      expect(await liveEntries(h, doc.versionId)).toBe(1);
      expect(await h.row(doc.versionId)).toMatchObject({ status: "queued", lease_generation: 4 });
    }
  });

  it("a retry that waits for an uncommitted claim is refused: the version is running", async () => {
    const doc = await seedDoc(h, wsA, "queued");
    const claimed = await run(wsA, (r) => r.claim({ versionId: doc.versionId }));
    expect(claimed).not.toBeNull();
    expect(await retry(h, userA, wsA, doc.documentId)).toBe("not_retryable");
  });
});
