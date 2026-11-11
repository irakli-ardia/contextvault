import { afterAll, describe, expect, it } from "vitest";
import {
  chunkSet,
  derivedCounts,
  documentRow,
  seedDoc,
  softDelete,
} from "../../testing/deletion-test-support";
import { createIngestionHarness } from "../../testing/ingestion-test-support";
import { recover } from "../../testing/recovery-test-support";

// The M1.7 delete command through the real application and worker roles. Physical purge of
// objects and derived rows is not built (migration 0018): derived rows stay, unreachable.
const h = await createIngestionHarness();
const { wsA, wsB, userA, userB, run } = h;
afterAll(() => h.close());

const closed = {
  status: "failed",
  error_stage: null,
  error_code: "document.deleted",
  error_retryable: false,
};

describe("softDelete", () => {
  it.each(["uploaded", "queued", "parsing", "chunking"] as const)(
    "marks the document deleted and closes its %s version, invalidating the lease",
    async (status) => {
      const doc = await seedDoc(h, wsA, status);
      const before = await h.row(doc.versionId);
      expect(await softDelete(h, userA, wsA, doc.documentId)).toBe("deleted");

      expect((await documentRow(h, doc.documentId)).deleted_at).toBeInstanceOf(Date);
      expect(await h.row(doc.versionId)).toMatchObject({
        ...closed,
        lease_generation: before.lease_generation + 1,
      });
    },
  );

  it("keeps a ready version unchanged, clears the pointer and leaves derived rows in place", async () => {
    const doc = await seedDoc(h, wsA, "ready");
    expect((await documentRow(h, doc.documentId)).active_version_id).toBe(doc.versionId);
    const before = await h.row(doc.versionId);

    expect(await softDelete(h, userA, wsA, doc.documentId)).toBe("deleted");

    expect(await documentRow(h, doc.documentId)).toMatchObject({ active_version_id: null });
    expect(await h.row(doc.versionId)).toMatchObject({
      status: "ready",
      lease_generation: before.lease_generation,
      updated_at: before.updated_at,
    });
    expect(await derivedCounts(h, doc.versionId)).toEqual({ sections: 1, chunks: 1 });
  });

  it("is idempotent: a repeat changes nothing", async () => {
    const doc = await seedDoc(h, wsA, "parsing");
    await softDelete(h, userA, wsA, doc.documentId);
    const [document, version] = [await documentRow(h, doc.documentId), await h.row(doc.versionId)];

    expect(await softDelete(h, userA, wsA, doc.documentId)).toBe("already_deleted");
    expect(await documentRow(h, doc.documentId)).toEqual(document);
    expect(await h.row(doc.versionId)).toEqual(version);
  });

  it("reports a document of another workspace as not found and touches nothing", async () => {
    const doc = await seedDoc(h, wsA, "uploaded");
    const before = await h.row(doc.versionId);

    expect(await softDelete(h, userB, wsB, doc.documentId)).toBe("not_found");
    await expect(softDelete(h, userB, wsA, doc.documentId)).rejects.toThrow(); // not a member

    expect((await documentRow(h, doc.documentId)).deleted_at).toBeNull();
    expect(await h.row(doc.versionId)).toEqual(before);
  });

  it("rolls everything back when the transaction fails after the delete", async () => {
    const doc = await seedDoc(h, wsA, "chunking");
    const before = await h.row(doc.versionId);

    await expect(
      h.fx.persistence.unitOfWork.run({ userId: userA, workspaceId: wsA }, async (r) => {
        await r.documentDeletion.softDelete(wsA, doc.documentId);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect((await documentRow(h, doc.documentId)).deleted_at).toBeNull();
    expect(await h.row(doc.versionId)).toEqual(before);
  });
});

describe("after deletion nothing resurrects the document", () => {
  it("a running worker loses every fenced write", async () => {
    const doc = await seedDoc(h, wsA, "chunking");
    const { versionId, generation } = doc;
    await softDelete(h, userA, wsA, doc.documentId);
    const after = await h.row(versionId);

    expect(await run(wsA, (r) => r.heartbeat({ versionId, leaseGeneration: generation }))).toBe(
      false,
    );
    expect(
      await run(wsA, (r) =>
        r.transition({ versionId, leaseGeneration: generation, from: "chunking", to: "queued" }),
      ),
    ).toBe(false);
    expect(
      await run(wsA, (r) =>
        r.failVersion({
          versionId,
          leaseGeneration: generation,
          from: "chunking",
          failure: { stage: "chunking", code: "x", retryable: true },
        }),
      ),
    ).toBe(false);
    expect(
      await run(wsA, (r) =>
        r.activate({ versionId, leaseGeneration: generation, chunkSet: chunkSet() }),
      ),
    ).toBe(false);
    // The fence moved on, so even the new generation cannot activate a closed version.
    expect(
      await run(wsA, (r) =>
        r.activate({ versionId, leaseGeneration: after.lease_generation, chunkSet: chunkSet() }),
      ),
    ).toBe(false);

    expect(await h.row(versionId)).toEqual(after);
    expect(await derivedCounts(h, versionId)).toEqual({ sections: 0, chunks: 0 });
    expect((await documentRow(h, doc.documentId)).active_version_id).toBeNull();
  });

  it("refuses a claim of the pending delivery and recovery of the old lease", async () => {
    const queued = await seedDoc(h, wsA, "queued");
    const running = await seedDoc(h, wsA, "parsing");
    await softDelete(h, userA, wsA, queued.documentId);
    await softDelete(h, userA, wsA, running.documentId);

    expect(await run(wsA, (r) => r.claim({ versionId: queued.versionId }))).toBeNull();
    await recover(h.worker.recoveryUnitOfWork, wsA, running.versionId, running.generation);

    // The queued version's entry is still pending; its delivery is refused above and the version
    // stays closed. Recovery of the running one wrote no new entry.
    for (const { versionId } of [queued, running]) {
      expect(await h.row(versionId)).toMatchObject(closed);
    }
    expect((await h.outboxRows(running.versionId)).filter((e) => e.dispatched_at === null)).toEqual(
      [],
    );
  });
});
