import {
  type UploadQuota,
  type UserId,
  WorkspaceAccessDenied,
  type WorkspaceId,
} from "@contextvault/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalizeInput, newUpload, reserveInput, roomy, seedDocument } from "./document-fixture";
import { createTenantFixture } from "./tenant-fixture";

const fx = await createTenantFixture(12);
const run = fx.persistence.unitOfWork.run.bind(fx.persistence.unitOfWork);
const MiB = 1024 * 1024;
const quota25: UploadQuota = { maxDocuments: 50, maxBytes: 25 * MiB };

let user: UserId;
beforeAll(async () => {
  user = await fx.seedUser();
});
afterAll(() => fx.close());

const freshWorkspace = (): Promise<WorkspaceId> => fx.createWorkspace(user);
const inWs = (workspaceId: WorkspaceId) => ({ userId: user, workspaceId });
const reserve = (w: WorkspaceId, bytes: number, quota = quota25) =>
  run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(newUpload(w, user), bytes), quota));
const pendingCount = (w: WorkspaceId) =>
  run(inWs(w), (r) => r.uploads.listPendingUploads(w, new Date(Date.now() + 60_000), 100)).then(
    (rows) => rows.length,
  );

describe("byte and document accounting", () => {
  it("rejects 10 MiB when 10 MiB is finalized and 10 MiB is pending against 25 MiB", async () => {
    const w = await freshWorkspace();
    await seedDocument(fx, w, user, "finalized", 10 * MiB);
    expect(await reserve(w, 10 * MiB)).toEqual({ outcome: "reserved" });
    expect(await reserve(w, 10 * MiB)).toEqual({ outcome: "quota", reason: "bytes" });
    expect(await reserve(w, 5 * MiB)).toEqual({ outcome: "reserved" }); // exactly 25 MiB
    expect(await reserve(w, 1)).toEqual({ outcome: "quota", reason: "bytes" });
  });

  it("counts an expired reservation next to a finalized document", async () => {
    const w = await freshWorkspace();
    await seedDocument(fx, w, user, "finalized", 10 * MiB);
    const old = newUpload(w, user);
    await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(old, 10 * MiB), quota25));
    await fx.fixture.query(
      "update pending_uploads set created_at = now() - interval '9 days' where id = $1",
      [old.versionId],
    );
    expect(await reserve(w, 10 * MiB)).toEqual({ outcome: "quota", reason: "bytes" });
  });

  it("turns pending usage into finalized usage without counting it twice", async () => {
    const w = await freshWorkspace();
    const tight: UploadQuota = { maxDocuments: 2, maxBytes: 20 * MiB };
    await seedDocument(fx, w, user, "first", 10 * MiB);
    const second = newUpload(w, user);
    await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(second, 10 * MiB), tight));
    // 10 finalized + 10 own reservation = exactly the ceiling: own usage must not be counted again.
    const result = await run(inWs(w), (r) =>
      r.uploads.finalizeUpload(finalizeInput(second, "second", 10 * MiB), tight),
    );
    expect(result).toMatchObject({ outcome: "created" });
    expect(await pendingCount(w)).toBe(0);
    // Now 20 MiB / 2 documents are all finalized: one more byte or document is refused.
    expect(await reserve(w, 1, tight)).toEqual({ outcome: "quota", reason: "documents" });
    expect(await reserve(w, 1, { maxDocuments: 3, maxBytes: 20 * MiB })).toEqual({
      outcome: "quota",
      reason: "bytes",
    });
    expect(await reserve(w, 1, { maxDocuments: 3, maxBytes: 20 * MiB + 1 })).toEqual({
      outcome: "reserved",
    });
  });

  it("finalizes concurrently without false refusals, and never past the ceiling", async () => {
    const w = await freshWorkspace();
    const uploads = [newUpload(w, user), newUpload(w, user)];
    for (const u of uploads)
      await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(u, 10 * MiB), quota25));
    const results = await Promise.all(
      uploads.map((u, i) =>
        run(inWs(w), (r) => r.uploads.finalizeUpload(finalizeInput(u, `c${i}`, 10 * MiB), quota25)),
      ),
    );
    expect(results.map((r) => r.outcome)).toEqual(["created", "created"]);
    expect(await reserve(w, 10 * MiB)).toEqual({ outcome: "quota", reason: "bytes" });
  });

  it("gives the same answer whether a competing reservation lands before or after a finalize", async () => {
    for (let round = 0; round < 5; round++) {
      const w = await freshWorkspace();
      await seedDocument(fx, w, user, "base", 10 * MiB);
      const a = newUpload(w, user);
      await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(a, 10 * MiB), quota25));
      const [fin, rival] = await Promise.all([
        run(inWs(w), (r) => r.uploads.finalizeUpload(finalizeInput(a, "a", 10 * MiB), quota25)),
        reserve(w, 10 * MiB),
      ]);
      expect(fin.outcome).toBe("created");
      expect(rival).toEqual({ outcome: "quota", reason: "bytes" });
    }
  });

  it("charges nothing for duplicate content, even at the document ceiling", async () => {
    const w = await freshWorkspace();
    const one: UploadQuota = { maxDocuments: 1, maxBytes: 25 * MiB };
    const first = newUpload(w, user);
    await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(first, 1 * MiB), one));
    await run(inWs(w), (r) => r.uploads.finalizeUpload(finalizeInput(first, "dup", 1 * MiB), one));
    // The ceiling is full, so the retry's own reservation is refused up front...
    expect(await reserve(w, 1 * MiB, one)).toEqual({ outcome: "quota", reason: "documents" });
    // ...but a reservation made earlier still resolves to the existing document.
    const early = newUpload(w, user);
    await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(early, 1 * MiB), roomy));
    const result = await run(inWs(w), (r) =>
      r.uploads.finalizeUpload(finalizeInput(early, "dup", 1 * MiB), one),
    );
    expect(result).toMatchObject({ outcome: "duplicate", document: { id: first.documentId } });
  });

  it("rolls a finalize back completely: no document, reservation intact and still counted", async () => {
    const w = await freshWorkspace();
    const u = newUpload(w, user);
    await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(u, 10 * MiB), quota25));
    const failing = run(inWs(w), async (r) => {
      const result = await r.uploads.finalizeUpload(finalizeInput(u, "rb", 10 * MiB), quota25);
      expect(result.outcome).toBe("created");
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    expect(await run(inWs(w), (r) => r.documents.list(w, 10))).toEqual([]);
    expect(await pendingCount(w)).toBe(1);
    expect(await reserve(w, 20 * MiB)).toEqual({ outcome: "quota", reason: "bytes" });
  });
});

describe("duplicate finalization contract", () => {
  it("creates nothing, leaves the reservation discoverable and counted, and frees it only on release", async () => {
    const w = await freshWorkspace();
    const tight: UploadQuota = { maxDocuments: 5, maxBytes: 20 * MiB };
    const first = await seedDocument(fx, w, user, "same", 10 * MiB);
    const retry = newUpload(w, user);
    await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(retry, 10 * MiB), tight));

    const result = await run(inWs(w), (r) =>
      r.uploads.finalizeUpload(finalizeInput(retry, "same", 10 * MiB), tight),
    );
    expect(result).toMatchObject({ outcome: "duplicate", document: { id: first.documentId } });

    const state = await run(inWs(w), async (r) => ({
      documents: await r.documents.list(w, 10),
      pending: await r.uploads.listPendingUploads(w, new Date(Date.now() + 60_000), 10),
    }));
    expect(state.documents.map((d) => d.id)).toEqual([first.documentId]);
    expect(state.pending).toEqual([
      expect.objectContaining({ versionId: retry.versionId, storageKey: retry.storageKey }),
    ]);
    expect(
      (await fx.fixture.query("select 1 from document_versions where id = $1", [retry.versionId]))
        .rowCount,
    ).toBe(0);

    // The object may still exist, so the quota stays charged until release.
    expect(await reserve(w, 1, tight)).toEqual({ outcome: "quota", reason: "bytes" });
    expect(await run(inWs(w), (r) => r.uploads.releaseUpload(w, retry.versionId))).toBe(true);
    expect(await reserve(w, 1, tight)).toEqual({ outcome: "reserved" });
  });
});

describe("transaction-local workspace", () => {
  it("refuses to reserve, finalize or release for a workspace other than the context's", async () => {
    const other = await fx.seedUser();
    const [mine, theirs] = [await freshWorkspace(), await fx.createWorkspace(other)];
    const foreign = newUpload(theirs, user);

    await expect(
      run(inWs(mine), (r) => r.uploads.reserveUpload(reserveInput(foreign), roomy)),
    ).rejects.toBeInstanceOf(WorkspaceAccessDenied);
    await run({ userId: other, workspaceId: theirs }, (r) =>
      r.uploads.reserveUpload({ ...reserveInput(foreign), createdBy: other }, roomy),
    );
    await expect(
      run(inWs(mine), (r) => r.uploads.finalizeUpload(finalizeInput(foreign), roomy)),
    ).rejects.toBeInstanceOf(WorkspaceAccessDenied);
    expect(await run(inWs(mine), (r) => r.uploads.releaseUpload(theirs, foreign.versionId))).toBe(
      false,
    );

    const owned = await fx.fixture.query("select 1 from pending_uploads where id = $1", [
      foreign.versionId,
    ]);
    expect(owned.rowCount).toBe(1);
    expect(
      (await fx.fixture.query("select 1 from documents where workspace_id = $1", [theirs]))
        .rowCount,
    ).toBe(0);
  });
});
