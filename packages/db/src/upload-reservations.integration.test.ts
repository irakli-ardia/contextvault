import {
  UploadConflict,
  type UploadQuota,
  type UserId,
  type WorkspaceId,
} from "@contextvault/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newUpload, reserveInput, roomy } from "./document-fixture";
import { createTenantFixture } from "./tenant-fixture";

const fx = await createTenantFixture(12);
const run = fx.persistence.unitOfWork.run.bind(fx.persistence.unitOfWork);
const MiB = 1024 * 1024;

let user: UserId;
let other: UserId;
let ws: WorkspaceId;

beforeAll(async () => {
  [user, other] = await Promise.all([fx.seedUser(), fx.seedUser()]);
  ws = await fx.createWorkspace(user);
  await run({ userId: user, workspaceId: ws }, (r) => r.workspaces.addMember(ws, other, "member"));
});
afterAll(() => fx.close());

// A fresh workspace per test keeps quota arithmetic independent.
async function freshWorkspace(): Promise<WorkspaceId> {
  const id = await fx.createWorkspace(user);
  await run({ userId: user, workspaceId: id }, (r) => r.workspaces.addMember(id, other, "member"));
  return id;
}
const inWs = (w: WorkspaceId, userId: UserId = user) => ({ userId, workspaceId: w });
const outcomes = (results: readonly { outcome: string }[]) => {
  const counts: Record<string, number> = {};
  for (const { outcome } of results) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
};

describe("quota", () => {
  it("refuses a reservation past the document or byte ceiling, naming which", async () => {
    const w = await freshWorkspace();
    const quota: UploadQuota = { maxDocuments: 2, maxBytes: 25 * MiB };
    const reserve = (bytes: number) =>
      run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(newUpload(w, user), bytes), quota));
    expect(await reserve(10 * MiB)).toEqual({ outcome: "reserved" });
    expect(await reserve(20 * MiB)).toEqual({ outcome: "quota", reason: "bytes" });
    expect(await reserve(1)).toEqual({ outcome: "reserved" });
    expect(await reserve(1)).toEqual({ outcome: "quota", reason: "documents" });
  });

  it("lets concurrent reservations pass only while their combined size fits", async () => {
    const w = await freshWorkspace();
    const quota: UploadQuota = { maxDocuments: 50, maxBytes: 25 * MiB };
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        run(inWs(w, i % 2 === 0 ? user : other), (r) =>
          r.uploads.reserveUpload(
            reserveInput(newUpload(w, i % 2 === 0 ? user : other), 10 * MiB),
            quota,
          ),
        ),
      ),
    );
    expect(outcomes(results)).toEqual({ reserved: 2, quota: 8 });
  });

  it("lets concurrent reservations pass only while the document count fits", async () => {
    const w = await freshWorkspace();
    const quota: UploadQuota = { maxDocuments: 3, maxBytes: 200 * MiB };
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(newUpload(w, user), 1), quota)),
      ),
    );
    expect(outcomes(results)).toEqual({ reserved: 3, quota: 7 });
  });

  it("releases a reservation with its rolled-back transaction", async () => {
    const w = await freshWorkspace();
    const quota: UploadQuota = { maxDocuments: 1, maxBytes: 200 * MiB };
    const failed = run(inWs(w), async (r) => {
      expect(await r.uploads.reserveUpload(reserveInput(newUpload(w, user)), quota)).toEqual({
        outcome: "reserved",
      });
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    expect(
      await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(newUpload(w, user)), quota)),
    ).toEqual({ outcome: "reserved" });
  });

  it("counts an expired reservation until it is released, and frees it then", async () => {
    const w = await freshWorkspace();
    const quota: UploadQuota = { maxDocuments: 1, maxBytes: 200 * MiB };
    const old = newUpload(w, user);
    await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(old), quota));
    await fx.fixture.query(
      "update pending_uploads set created_at = now() - interval '2 days' where id = $1",
      [old.versionId],
    );

    const next = () =>
      run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(newUpload(w, user)), quota));
    expect(await next()).toEqual({ outcome: "quota", reason: "documents" });

    const cutoff = new Date(Date.now() - 15 * 60_000);
    const stale = await run(inWs(w, other), (r) => r.uploads.listPendingUploads(w, cutoff, 10));
    expect(stale).toEqual([
      expect.objectContaining({ versionId: old.versionId, storageKey: old.storageKey }),
    ]);

    // Only the creator may release: the object may still exist, so a bystander cannot free its quota.
    expect(await run(inWs(w, other), (r) => r.uploads.releaseUpload(w, old.versionId))).toBe(false);
    expect(await run(inWs(w), (r) => r.uploads.releaseUpload(w, old.versionId))).toBe(true);
    expect(await run(inWs(w), (r) => r.uploads.releaseUpload(w, old.versionId))).toBe(false);
    expect(await next()).toEqual({ outcome: "reserved" });
  });

  it("refuses to reuse a reservation id", async () => {
    const w = await freshWorkspace();
    const u = newUpload(w, user);
    await run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(u), roomy));
    await expect(
      run(inWs(w), (r) => r.uploads.reserveUpload(reserveInput(u), roomy)),
    ).rejects.toBeInstanceOf(UploadConflict);
  });
});
