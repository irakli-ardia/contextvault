import { randomUUID } from "node:crypto";
import { createPurgeSweep, type PurgeDocumentInput, purgeDocument } from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { derivedCounts, documentRow, seedDoc } from "../../testing/deletion-test-support";
import { createIngestionHarness } from "../../testing/ingestion-test-support";
import {
  ageDeletion,
  deletedDoc,
  hour,
  keyOf,
  memoryStore,
  purgedAt,
} from "../../testing/purge-test-support";

// The M1.7 physical purge through the real worker role: objects first, then derived rows and
// purged_at in one transaction. The object store is an in-memory fake that can fail on demand.
const h = await createIngestionHarness();
const { wsA, wsB, worker } = h;
afterAll(() => h.close());

const input = (
  doc: { documentId: PurgeDocumentInput["documentId"] },
  ws = wsA,
): PurgeDocumentInput => ({
  workspaceId: ws,
  documentId: doc.documentId,
  retentionMs: hour,
});
const depsWith = (store: ReturnType<typeof memoryStore>["store"]) => ({
  uow: worker.purgeUnitOfWork,
  store,
});
const versionRows = async (documentId: string) =>
  (await h.fx.fixture.query("select 1 from document_versions where document_id = $1", [documentId]))
    .rows.length;

describe("purgeDocument", () => {
  it("removes the object, chunks and sections, marks purged and keeps the tombstone", async () => {
    const doc = await deletedDoc(h, wsA, 2 * hour);
    const { store, deleted } = memoryStore();
    expect(await purgeDocument(depsWith(store), input(doc))).toBe("purged");

    expect(deleted).toEqual([keyOf(wsA, doc)]);
    expect(await derivedCounts(h, doc.versionId)).toEqual({ sections: 0, chunks: 0 });
    expect(await purgedAt(h, doc.documentId)).toBeInstanceOf(Date);
    expect(await documentRow(h, doc.documentId)).toMatchObject({ active_version_id: null });
    expect(await versionRows(doc.documentId)).toBe(1);
    expect((await h.row(doc.versionId)).status).toBe("ready");
  });

  it("honours the retention boundary on the database clock", async () => {
    const doc = await deletedDoc(h, wsA);
    await ageDeletion(h, doc.documentId, hour - 60_000);
    const { store, deleted } = memoryStore();
    expect(await purgeDocument(depsWith(store), input(doc))).toBe("skipped");
    expect(deleted).toEqual([]);
    expect(await derivedCounts(h, doc.versionId)).toEqual({ sections: 1, chunks: 1 });

    await ageDeletion(h, doc.documentId, hour + 60_000);
    expect(await purgeDocument(depsWith(store), input(doc))).toBe("purged");
  });

  it("never purges a live document", async () => {
    const doc = await seedDoc(h, wsA, "ready");
    const { store, deleted } = memoryStore();
    expect(await purgeDocument(depsWith(store), input(doc))).toBe("skipped");
    expect(deleted).toEqual([]);
    expect(await derivedCounts(h, doc.versionId)).toEqual({ sections: 1, chunks: 1 });
    expect(await purgedAt(h, doc.documentId)).toBeNull();
  });

  it("touches nothing when another workspace is asserted for the document", async () => {
    const doc = await deletedDoc(h, wsA, 2 * hour);
    const { store, deleted } = memoryStore();
    expect(await purgeDocument(depsWith(store), input(doc, wsB))).toBe("skipped");
    expect(deleted).toEqual([]);
    expect(await derivedCounts(h, doc.versionId)).toEqual({ sections: 1, chunks: 1 });
    expect(await purgedAt(h, doc.documentId)).toBeNull();
  });

  it("skips a deleted document that still has a waiting version, deleting nothing", async () => {
    const doc = await deletedDoc(h, wsA, 2 * hour);
    await h.fx.fixture.query("update document_versions set status = 'queued' where id = $1", [
      doc.versionId,
    ]);
    const { store, deleted } = memoryStore();
    expect(await purgeDocument(depsWith(store), input(doc))).toBe("skipped");
    expect(deleted).toEqual([]);
  });

  it("keeps everything when the object store fails, and a retry completes", async () => {
    const doc = await deletedDoc(h, wsA, 2 * hour);
    const broken = memoryStore(() => true);
    await expect(purgeDocument(depsWith(broken.store), input(doc))).rejects.toThrow();
    expect(await derivedCounts(h, doc.versionId)).toEqual({ sections: 1, chunks: 1 });
    expect(await purgedAt(h, doc.documentId)).toBeNull();

    const healthy = memoryStore();
    expect(await purgeDocument(depsWith(healthy.store), input(doc))).toBe("purged");
    expect(healthy.deleted).toEqual([keyOf(wsA, doc)]);
  });

  it("recovers from a database failure after the objects are gone", async () => {
    const doc = await deletedDoc(h, wsA, 2 * hour);
    const { store, deleted } = memoryStore();
    let runs = 0;
    const flaky = {
      store,
      uow: {
        run: <T>(...args: Parameters<typeof worker.purgeUnitOfWork.run<T>>) =>
          ++runs === 2
            ? Promise.reject(new Error("connection lost"))
            : worker.purgeUnitOfWork.run(...args),
      },
    };
    await expect(purgeDocument(flaky, input(doc))).rejects.toThrow("connection lost");
    expect(deleted).toHaveLength(1); // the object is already gone, the rows are not
    expect(await derivedCounts(h, doc.versionId)).toEqual({ sections: 1, chunks: 1 });

    expect(await purgeDocument(depsWith(store), input(doc))).toBe("purged");
    expect(await derivedCounts(h, doc.versionId)).toEqual({ sections: 0, chunks: 0 });
  });

  it("refuses to mark a document that gained a version after the targets were read", async () => {
    const doc = await deletedDoc(h, wsA, 2 * hour);
    const targets = await worker.purgeUnitOfWork.run({ workspaceId: wsA }, (r) =>
      r.purge.readTargets({ documentId: doc.documentId, retentionMs: hour }),
    );
    if (targets === null) throw new Error("expected targets");
    const late = randomUUID();
    await h.fx.fixture.query(
      `insert into document_versions (id, document_id, workspace_id, version_no, storage_key, status)
       values ($1::uuid, $2::uuid, $3::uuid, 2, 'ws/' || $3::text || '/doc/' || $2::text || '/v/' || $1::text, 'failed')`,
      [late, doc.documentId, wsA],
    );
    const marked = await worker.purgeUnitOfWork.run({ workspaceId: wsA }, (r) =>
      r.purge.finalize({ documentId: doc.documentId, versionIds: targets }),
    );
    expect(marked).toBe(false);
    expect(await purgedAt(h, doc.documentId)).toBeNull();
  });

  it("is idempotent: a repeat is skipped and deletes nothing more", async () => {
    const doc = await deletedDoc(h, wsA, 2 * hour);
    const { store, deleted } = memoryStore();
    expect(await purgeDocument(depsWith(store), input(doc))).toBe("purged");
    const first = await purgedAt(h, doc.documentId);
    expect(await purgeDocument(depsWith(store), input(doc))).toBe("skipped");
    expect(deleted).toHaveLength(1);
    expect(await purgedAt(h, doc.documentId)).toEqual(first);
  });

  it("converges when two workers purge the same document at once", async () => {
    const doc = await deletedDoc(h, wsA, 2 * hour);
    const { store } = memoryStore();
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => purgeDocument(depsWith(store), input(doc))),
    );
    expect(outcomes).toContain("purged");
    expect(outcomes.filter((o) => o === "purged")).toHaveLength(1);
    expect(await derivedCounts(h, doc.versionId)).toEqual({ sections: 0, chunks: 0 });
    expect(await purgedAt(h, doc.documentId)).toBeInstanceOf(Date);
  });
});

describe("the purge sweep over the real source", () => {
  it("lists deleted, unpurged documents of every workspace, oldest first, and wraps", async () => {
    const [a, b] = [await deletedDoc(h, wsA, 5 * hour), await deletedDoc(h, wsB, 4 * hour)];
    const live = await seedDoc(h, wsA, "ready");
    const first = await worker.purgeSource.listEligible({ limit: 100, retentionMs: hour });
    const ids = first.map((c) => c.documentId);
    expect(ids).toContain(a.documentId);
    expect(ids).toContain(b.documentId);
    expect(ids).not.toContain(live.documentId);
    expect(ids.indexOf(a.documentId)).toBeLessThan(ids.indexOf(b.documentId));

    const [head] = first;
    if (head === undefined) throw new Error("expected candidates");
    const rest = await worker.purgeSource.listEligible({
      limit: 100,
      retentionMs: hour,
      after: head.cursor,
    });
    expect(rest.map((c) => c.documentId)).not.toContain(head.documentId);
  });

  it("purges across workspaces in bounded batches and leaves a failing document for later", async () => {
    const [a, b] = [await deletedDoc(h, wsA, 9 * hour), await deletedDoc(h, wsB, 9 * hour)];
    const { store, deleted } = memoryStore((key) => key === keyOf(wsA, a));
    const sweep = createPurgeSweep({
      ...depsWith(store),
      source: worker.purgeSource,
      batchSize: 100,
      retentionMs: hour,
    });
    const batch = await sweep();
    expect(batch.errors).toHaveLength(1);
    expect(deleted).toContain(keyOf(wsB, b));
    expect(await purgedAt(h, b.documentId)).toBeInstanceOf(Date);
    expect(await purgedAt(h, a.documentId)).toBeNull();
  });
});
