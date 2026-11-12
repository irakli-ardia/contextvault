import { afterAll, describe, expect, it } from "vitest";
import { seedDoc, softDelete } from "../../testing/deletion-test-support";
import { createIngestionHarness } from "../../testing/ingestion-test-support";
import { sqlState } from "../../testing/tenant-fixture";

// What the application role can do to documents and versions, probed with raw SQL: the delete
// path is the only write, and the database admits nothing wider than the command makes.
const h = await createIngestionHarness();
const { wsA, wsB, userA, userB } = h;
afterAll(() => h.close());

const as = (user: typeof userA, ws: typeof wsA) => ({ userId: user, workspaceId: ws });
const affected = async (
  ctx: ReturnType<typeof as>,
  text: string,
  values: unknown[],
): Promise<number> =>
  (await h.fx.queryAs<{ id: string }>(ctx, `${text} returning 1 as id`, values)).length;

describe("application role writes on documents", () => {
  it("cannot delete a document of another workspace, even naming its workspace", async () => {
    const doc = await seedDoc(h, wsA, "uploaded");
    const text = "update documents set deleted_at = now() where id = $1";
    expect(await affected(as(userB, wsB), text, [doc.documentId])).toBe(0);
    expect(await sqlState(h.fx.queryAs(as(userB, wsA), text, [doc.documentId]))).toBeUndefined();
    expect(await affected(as(userB, wsA), text, [doc.documentId])).toBe(0);
  });

  it("cannot restore a deleted document or change any other column", async () => {
    const doc = await seedDoc(h, wsA, "uploaded");
    await softDelete(h, userA, wsA, doc.documentId);
    expect(
      await affected(as(userA, wsA), "update documents set deleted_at = null where id = $1", [
        doc.documentId,
      ]),
    ).toBe(0);
    expect(
      await sqlState(
        h.fx.queryAs(as(userA, wsA), "update documents set display_name = 'x' where id = $1", [
          doc.documentId,
        ]),
      ),
    ).toBe("42501");
  });

  it("cannot delete a document without clearing its active pointer", async () => {
    const doc = await seedDoc(h, wsA, "ready");
    expect(
      await sqlState(
        h.fx.queryAs(as(userA, wsA), "update documents set deleted_at = now() where id = $1", [
          doc.documentId,
        ]),
      ),
    ).toBe("42501");
  });

  it("cannot remove rows", async () => {
    const doc = await seedDoc(h, wsA, "uploaded");
    expect(
      await sqlState(
        h.fx.queryAs(as(userA, wsA), "delete from documents where id = $1", [doc.documentId]),
      ),
    ).toBe("42501");
  });
});

describe("application role writes on document versions", () => {
  const close =
    "update document_versions set status = 'failed', error_code = 'document.deleted', error_retryable = false, error_stage = null, lease_generation = lease_generation + 1 where id = $1";

  it("cannot close a version of a live document", async () => {
    const doc = await seedDoc(h, wsA, "uploaded");
    expect(await affected(as(userA, wsA), close, [doc.versionId])).toBe(0);
  });

  it("cannot close a version of another workspace's deleted document", async () => {
    const doc = await seedDoc(h, wsA, "uploaded");
    await h.fx.fixture.query("update documents set deleted_at = now() where id = $1", [
      doc.documentId,
    ]);
    expect(await affected(as(userB, wsB), close, [doc.versionId])).toBe(0);
    expect(await h.row(doc.versionId)).toMatchObject({ status: "uploaded" });
  });

  it("admits only the closed state, and never touches a ready version", async () => {
    const running = await seedDoc(h, wsA, "parsing");
    const ready = await seedDoc(h, wsA, "ready");
    await h.fx.fixture.query(
      "update documents set deleted_at = now(), active_version_id = null where id = any($1)",
      [[running.documentId, ready.documentId]],
    );
    for (const set of [
      "status = 'ready'",
      "status = 'queued'",
      "status = 'failed', error_code = 'other', error_retryable = false, error_stage = null",
      "status = 'failed', error_code = 'document.deleted', error_retryable = true, error_stage = null",
      "status = 'failed', error_code = 'document.deleted', error_retryable = false, error_stage = 'parsing'",
    ]) {
      const state = await sqlState(
        h.fx.queryAs(as(userA, wsA), `update document_versions set ${set} where id = $1`, [
          running.versionId,
        ]),
      );
      // The policy (42501), or the lifecycle trigger (23514) when the transition is illegal; it fires first.
      expect(state, set).toMatch(/^(42501|23514)$/);
    }
    expect(await affected(as(userA, wsA), close, [ready.versionId])).toBe(0);
    expect(await h.row(ready.versionId)).toMatchObject({ status: "ready" });
    expect(await h.row(running.versionId)).toMatchObject({ status: "parsing" });
  });

  it("cannot change a column outside the closing", async () => {
    const doc = await seedDoc(h, wsA, "uploaded");
    expect(
      await sqlState(
        h.fx.queryAs(as(userA, wsA), "update document_versions set version_no = 2 where id = $1", [
          doc.versionId,
        ]),
      ),
    ).toBe("42501");
  });
});
