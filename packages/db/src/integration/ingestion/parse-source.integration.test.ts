import type { DocumentVersionId } from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { createIngestionHarness } from "../../testing/ingestion-test-support";

// The worker's read of what a stage needs, through the worker role against real PostgreSQL.
const h = await createIngestionHarness();
afterAll(() => h.close());

const find = (ws: typeof h.wsA, versionId: DocumentVersionId) =>
  h.worker.parseSourceUnitOfWork.run({ workspaceId: ws }, ({ parseSource }) =>
    parseSource.findParseSource(versionId),
  );

const documentOf = async (versionId: string) =>
  (
    await h.fx.fixture.query<{ document_id: string }>(
      "select document_id from document_versions where id = $1",
      [versionId],
    )
  ).rows[0]?.document_id;

describe("findParseSource", () => {
  it("finds the document of a version in the job's workspace", async () => {
    const id = await h.seed(h.wsA);
    expect(await find(h.wsA, id)).toEqual({ documentId: await documentOf(id) });
  });

  it("finds nothing for another workspace's version", async () => {
    const id = await h.seed(h.wsA);
    expect(await find(h.wsB, id)).toBeNull();
  });

  it("finds nothing once the document is deleted", async () => {
    const id = await h.seed(h.wsA);
    await h.fx.fixture.query("update documents set deleted_at = now() where id = $1", [
      await documentOf(id),
    ]);
    expect(await find(h.wsA, id)).toBeNull();
  });
});
