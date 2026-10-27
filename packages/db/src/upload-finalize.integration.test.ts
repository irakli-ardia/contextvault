import {
  type UploadQuota,
  UploadReservationMissing,
  type UserId,
  type WorkspaceId,
} from "@contextvault/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalizeInput, newUpload, reserveInput, roomy, seedDocument } from "./document-fixture";
import { createTenantFixture } from "./tenant-fixture";

const fx = createTenantFixture(12);
const run = fx.persistence.unitOfWork.run.bind(fx.persistence.unitOfWork);

let user: UserId;

beforeAll(async () => {
  user = await fx.seedUser();
});
afterAll(() => fx.close());

// A fresh workspace per test keeps quota arithmetic independent.
const freshWorkspace = (): Promise<WorkspaceId> => fx.createWorkspace(user);
const inWs = (w: WorkspaceId) => ({ userId: user, workspaceId: w });
const outcomes = (results: readonly { outcome: string }[]) => {
  const counts: Record<string, number> = {};
  for (const { outcome } of results) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
};

describe("finalize", () => {
  it("keeps a pending upload out of listings until it is finalized", async () => {
    const w = await freshWorkspace();
    const u = newUpload(w, user);
    const read = () =>
      run(inWs(w), async (r) => ({
        list: await r.documents.list(w, 50),
        one: await r.documents.findById(w, u.documentId),
      }));

    await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(u), roomy));
    expect(await read()).toEqual({ list: [], one: null });

    const result = await run(inWs(w), (r) => r.uploads.finalizeUpload(finalizeInput(u), roomy));
    expect(result).toMatchObject({
      outcome: "created",
      document: { id: u.documentId, status: "uploaded" },
    });
    const after = await read();
    expect(after.list.map((d) => d.id)).toEqual([u.documentId]);
    expect(after.one).toMatchObject({
      displayName: "report.pdf",
      mime: "application/pdf",
      sizeBytes: 100,
      status: "uploaded",
    });
    expect(
      await run(inWs(w), (r) => r.uploads.listPendingUploads(w, new Date(Date.now() + 1000), 10)),
    ).toEqual([]);
  });

  it("lists newest first", async () => {
    const w = await freshWorkspace();
    const first = await seedDocument(fx, w, user, "one");
    const second = await seedDocument(fx, w, user, "two");
    const ids = (await run(inWs(w), (r) => r.documents.list(w, 50))).map((d) => d.id);
    expect(ids).toEqual([second.documentId, first.documentId]);
  });

  it("refuses without a matching reservation and leaves no document", async () => {
    const w = await freshWorkspace();
    const u = newUpload(w, user);
    const attempt = () => run(inWs(w), (r) => r.uploads.finalizeUpload(finalizeInput(u), roomy));
    await expect(attempt()).rejects.toBeInstanceOf(UploadReservationMissing); // never reserved

    await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(u), roomy));
    await run(inWs(w), (r) => r.uploads.releaseUpload(w, u.versionId)); // swept
    await expect(attempt()).rejects.toBeInstanceOf(UploadReservationMissing);

    expect(await run(inWs(w), (r) => r.documents.list(w, 50))).toEqual([]);
    expect(
      (await fx.owner.query("select 1 from document_versions where workspace_id = $1", [w]))
        .rowCount,
    ).toBe(0);
  });

  it("answers identical content with the existing document and keeps the reservation", async () => {
    const w = await freshWorkspace();
    const first = await seedDocument(fx, w, user, "same");
    const retry = newUpload(w, user);
    await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(retry), roomy));
    const result = await run(inWs(w), (r) =>
      r.uploads.finalizeUpload(finalizeInput(retry, "same"), roomy),
    );
    expect(result).toMatchObject({ outcome: "duplicate", document: { id: first.documentId } });
    // The caller deletes the object, then releases: until then the intent record stays visible.
    expect(await run(inWs(w), (r) => r.uploads.releaseUpload(w, retry.versionId))).toBe(true);
    expect(await run(inWs(w), (r) => r.documents.list(w, 50))).toHaveLength(1);
  });

  it("creates exactly one document when identical uploads finalize concurrently", async () => {
    const w = await freshWorkspace();
    const uploads = Array.from({ length: 6 }, () => newUpload(w, user));
    for (const u of uploads)
      await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(u), roomy));
    const results = await Promise.all(
      uploads.map((u) =>
        run(inWs(w), (r) => r.uploads.finalizeUpload(finalizeInput(u, "race"), roomy)),
      ),
    );
    expect(outcomes(results)).toEqual({ created: 1, duplicate: 5 });
    expect(await run(inWs(w), (r) => r.documents.list(w, 50))).toHaveLength(1);
  });

  it("scopes duplicates to the workspace and ignores deleted documents", async () => {
    const [a, b] = [await freshWorkspace(), await freshWorkspace()];
    const inA = await seedDocument(fx, a, user, "shared");
    const inB = await seedDocument(fx, b, user, "shared");
    expect(inB.documentId).not.toBe(inA.documentId);

    await fx.owner.query("update documents set deleted_at = now() where id = $1", [inA.documentId]);
    expect(await run(inWs(a), (r) => r.documents.list(a, 50))).toEqual([]);
    expect(await run(inWs(a), (r) => r.documents.findById(a, inA.documentId))).toBeNull();
    const again = await seedDocument(fx, a, user, "shared");
    expect(again.documentId).not.toBe(inA.documentId);
  });

  it("applies the authoritative quota without counting its own reservation", async () => {
    const w = await freshWorkspace();
    const u = newUpload(w, user);
    await run(inWs(w), (r) =>
      r.uploads.reserveUpload(reserveInput(u), { maxDocuments: 1, maxBytes: 100 }),
    );
    const finalize = (quota: UploadQuota) =>
      run(inWs(w), (r) => r.uploads.finalizeUpload(finalizeInput(u), quota));
    expect(await finalize({ maxDocuments: 1, maxBytes: 99 })).toEqual({
      outcome: "quota",
      reason: "bytes",
    });
    expect(await finalize({ maxDocuments: 0, maxBytes: 100 })).toEqual({
      outcome: "quota",
      reason: "documents",
    });
    expect(await finalize({ maxDocuments: 1, maxBytes: 100 })).toMatchObject({
      outcome: "created",
    });
  });
});
