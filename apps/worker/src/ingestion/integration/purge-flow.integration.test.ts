import { createIngestionHarness } from "@contextvault/db/testing/ingestion";
import {
  createPurgeSweep,
  parseDocumentId,
  purgeDocument,
  StorageError,
} from "@contextvault/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildParserChild, pipeline, seedWithObject, store } from "./parse-pipeline-test-support";

// The whole life of a document through the real stack: SeaweedFS object, the real parser child,
// PostgreSQL under the real application and worker roles. Upload is seeded (its own tests cover
// it); parse, activation, soft delete and purge are real.
const h = await createIngestionHarness();
const { wsA, wsB, userA, worker } = h;
let childPath = "";
beforeAll(() => {
  childPath = buildParserChild();
}, 60_000);
afterAll(() => h.close());

const hour = 3_600_000;
const text = new TextEncoder().encode("The retention period decides when a deleted document goes.");

async function readyAndDeleted(ws = wsA) {
  const seeded = await seedWithObject(h, ws, text);
  expect(await pipeline(h, childPath).process(ws, seeded.versionId)).toEqual({
    outcome: "processed",
  });
  const { rows } = await h.fx.fixture.query<{ document_id: string }>(
    "select document_id from document_versions where id = $1",
    [seeded.versionId],
  );
  const documentId = rows[0]?.document_id ?? "";
  const owner = ws === wsA ? userA : h.userB;
  const outcome = await h.fx.persistence.unitOfWork.run({ userId: owner, workspaceId: ws }, (r) =>
    r.documentDeletion.softDelete(ws, parseDocumentId(documentId)),
  );
  expect(outcome).toBe("deleted");
  return { ...seeded, documentId };
}
const age = (documentId: string, ms: number) =>
  h.fx.fixture.query(
    "update documents set deleted_at = now() - $2 * interval '1 millisecond' where id = $1",
    [documentId, ms],
  );
const counts = async (versionId: string) => ({
  chunks: (await h.fx.fixture.query("select 1 from chunks where version_id = $1", [versionId]))
    .rowCount,
  sections: (await h.fx.fixture.query("select 1 from sections where version_id = $1", [versionId]))
    .rowCount,
});
const purgedAt = async (documentId: string) =>
  (await h.fx.fixture.query("select purged_at from documents where id = $1", [documentId])).rows[0]
    ?.purged_at;

describe("soft delete to physical purge", () => {
  it("keeps everything through retention, then removes object and derived rows", async () => {
    const doc = await readyAndDeleted();
    const deps = { uow: worker.purgeUnitOfWork, store };
    const input = {
      workspaceId: wsA,
      documentId: parseDocumentId(doc.documentId),
      retentionMs: hour,
    };

    // Deleted a moment ago: unreadable through the document but still stored, and not purged.
    expect(await purgeDocument(deps, input)).toBe("skipped");
    expect(await store.head(doc.key)).not.toBeNull();
    expect(await counts(doc.versionId)).toEqual({ chunks: 1, sections: 1 });

    await age(doc.documentId, 2 * hour);
    expect(await purgeDocument(deps, input)).toBe("purged");

    expect(await store.head(doc.key)).toBeNull();
    expect(await counts(doc.versionId)).toEqual({ chunks: 0, sections: 0 });
    expect(await purgedAt(doc.documentId)).toBeInstanceOf(Date);
    const tomb = await h.fx.fixture.query(
      "select d.deleted_at, d.active_version_id, v.status from documents d join document_versions v on v.document_id = d.id where d.id = $1",
      [doc.documentId],
    );
    expect(tomb.rows[0]).toMatchObject({ active_version_id: null, status: "ready" });
    expect(await purgeDocument(deps, input)).toBe("skipped");
  });

  it("survives an object-store outage and finishes on the next sweep", async () => {
    const doc = await readyAndDeleted();
    await age(doc.documentId, 2 * hour);
    let outage = true;
    const flaky = {
      ...store,
      delete: async (key: Parameters<typeof store.delete>[0]) => {
        if (outage) throw new StorageError("storage.unavailable", true);
        return store.delete(key);
      },
    };
    const sweep = createPurgeSweep({
      uow: worker.purgeUnitOfWork,
      store: flaky,
      source: {
        listEligible: async (i) =>
          (await worker.purgeSource.listEligible(i)).filter((c) => c.documentId === doc.documentId),
      },
      batchSize: 10,
      retentionMs: hour,
    });
    expect((await sweep()).errors).toHaveLength(1);
    expect(await store.head(doc.key)).not.toBeNull();
    expect(await purgedAt(doc.documentId)).toBeNull();

    outage = false;
    expect(await sweep()).toMatchObject({ purged: 1, errors: [] });
    expect(await store.head(doc.key)).toBeNull();
    expect(await purgedAt(doc.documentId)).toBeInstanceOf(Date);
  });

  it("never touches another workspace's document or object", async () => {
    const mine = await readyAndDeleted(wsA);
    const theirs = await readyAndDeleted(wsB);
    await age(mine.documentId, 2 * hour);
    await age(theirs.documentId, 2 * hour);
    // Asserting the wrong workspace for a document finds nothing to purge.
    const wrong = {
      workspaceId: wsB,
      documentId: parseDocumentId(mine.documentId),
      retentionMs: hour,
    };
    expect(await purgeDocument({ uow: worker.purgeUnitOfWork, store }, wrong)).toBe("skipped");
    expect(await store.head(mine.key)).not.toBeNull();
    expect(await counts(mine.versionId)).toEqual({ chunks: 1, sections: 1 });
  });
});
