import { purgeDocument } from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { newUpload, reserveInput, seedDocument } from "../../testing/document-fixture";
import { createIngestionHarness } from "../../testing/ingestion-test-support";
import { hour, memoryStore } from "../../testing/purge-test-support";

// Quota accounting around deletion (M1.7, D4): a deleted document's bytes count until the purge
// completes, while the document count stays live-only.
const h = await createIngestionHarness();
afterAll(() => h.close());

const quota = { maxDocuments: 2, maxBytes: 250 };

describe("quota while a deleted document awaits its purge", () => {
  it("counts its bytes until purged_at is set, but not its document slot", async () => {
    const ws = await h.fx.createWorkspace(h.userA, "quota");
    const doc = await seedDocument(h.fx, ws, h.userA, "first", 200);
    const context = { userId: h.userA, workspaceId: ws };
    const reserve = (declared: number) =>
      h.fx.persistence.unitOfWork.run(context, (r) =>
        r.uploads.reserveUpload(reserveInput(newUpload(ws, h.userA), declared), quota),
      );
    // Release each successful reservation so it never counts against the next probe.
    const probe = async (declared: number) => {
      const result = await reserve(declared);
      await h.fx.fixture.query("delete from pending_uploads where workspace_id = $1", [ws]);
      return result;
    };

    expect(await probe(100)).toMatchObject({ outcome: "quota", reason: "bytes" });
    await h.fx.persistence.unitOfWork.run(context, (r) =>
      r.documentDeletion.softDelete(ws, doc.documentId),
    );
    // Deleted but not purged: the 200 bytes are still stored.
    expect(await probe(100)).toMatchObject({ outcome: "quota", reason: "bytes" });
    expect(await probe(50)).not.toMatchObject({ outcome: "quota", reason: "documents" });

    await h.fx.fixture.query(
      "update documents set deleted_at = now() - $2 * interval '1 millisecond' where id = $1",
      [doc.documentId, 2 * hour],
    );
    const { store } = memoryStore();
    const purged = await purgeDocument(
      { uow: h.worker.purgeUnitOfWork, store },
      { workspaceId: ws, documentId: doc.documentId, retentionMs: hour },
    );
    expect(purged).toBe("purged");
    expect(await probe(100)).not.toMatchObject({ outcome: "quota" });
  });
});
