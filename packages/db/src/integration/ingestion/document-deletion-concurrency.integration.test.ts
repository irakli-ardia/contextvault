import type { DocumentVersionId } from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import {
  chunkSet,
  derivedCounts,
  documentRow,
  seedDoc,
  softDelete,
  waitUntilDocumentBlocked,
} from "../../testing/deletion-test-support";
import { createIngestionHarness } from "../../testing/ingestion-test-support";

// Delete and activation lock the document row first, then the version row: they serialize and
// never deadlock. Each case holds one transaction open on a barrier and watches the other wait.
const h = await createIngestionHarness();
const { wsA, userA, run, worker } = h;
afterAll(() => h.close());

const activate = (versionId: DocumentVersionId, leaseGeneration: number) =>
  run(wsA, (r) => r.activate({ versionId, leaseGeneration, chunkSet: chunkSet() }));

describe("delete and activation", () => {
  it("an activation that waits for an uncommitted delete finds the document deleted", async () => {
    const doc = await seedDoc(h, wsA, "chunking");
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
    const activating = activate(doc.versionId, doc.generation);
    await waitUntilDocumentBlocked(h, doc.documentId);
    gate.resolve();

    expect(await deleting).toBe("deleted");
    expect(await activating).toBe(false);
    expect(await h.row(doc.versionId)).toMatchObject({
      status: "failed",
      error_code: "document.deleted",
    });
    expect(await derivedCounts(h, doc.versionId)).toEqual({ sections: 0, chunks: 0 });
    expect((await documentRow(h, doc.documentId)).active_version_id).toBeNull();
  });

  it("a delete that waits for an uncommitted activation clears the pointer it set", async () => {
    const doc = await seedDoc(h, wsA, "chunking");
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const activating = worker.unitOfWork.run({ workspaceId: wsA }, async ({ ingestion }) => {
      const ok = await ingestion.activate({
        versionId: doc.versionId,
        leaseGeneration: doc.generation,
        chunkSet: chunkSet(),
      });
      entered.resolve();
      await gate.promise;
      return ok;
    });
    await entered.promise;
    const deleting = softDelete(h, userA, wsA, doc.documentId);
    await waitUntilDocumentBlocked(h, doc.documentId);
    gate.resolve();

    expect(await activating).toBe(true);
    expect(await deleting).toBe("deleted");
    expect(await documentRow(h, doc.documentId)).toMatchObject({ active_version_id: null });
    expect(await h.row(doc.versionId)).toMatchObject({ status: "ready" });
  });

  it("racing repeatedly never deadlocks and always ends consistent", async () => {
    for (let i = 0; i < 8; i++) {
      const doc = await seedDoc(h, wsA, "chunking");
      const [activated, deleted] = await Promise.allSettled([
        activate(doc.versionId, doc.generation),
        softDelete(h, userA, wsA, doc.documentId),
      ]);
      expect(activated.status).toBe("fulfilled");
      expect(deleted.status).toBe("fulfilled");

      const document = await documentRow(h, doc.documentId);
      expect(document.deleted_at).toBeInstanceOf(Date);
      expect(document.active_version_id).toBeNull();
      const version = await h.row(doc.versionId);
      expect(["ready", "failed"]).toContain(version.status);
      if (version.status === "failed") {
        expect(await derivedCounts(h, doc.versionId)).toEqual({ sections: 0, chunks: 0 });
      }
    }
  });
});
