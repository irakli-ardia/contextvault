import { describe, expect, it } from "vitest";
import { parseDocumentId } from "../kernel/ids";
import { UploadRejected } from "./errors";
import { uploadDocument } from "./upload-document";
import { actor, command, enc, fakeUpload, rejection } from "./upload-fakes";

describe("storage failures", () => {
  it("refused write while storage is unreachable: absence unconfirmed, reservation kept", async () => {
    const fx = fakeUpload();
    fx.faults.put = "refuse";
    fx.faults.deleteFails = true;
    await expect(uploadDocument(fx, command())).rejects.toEqual(
      rejection("storage.unavailable", "retained"),
    );
    expect(fx.reservations.size).toBe(1);
  });

  it("refused write: absent, reservation released", async () => {
    const fx = fakeUpload();
    fx.faults.put = "refuse";
    await expect(uploadDocument(fx, command())).rejects.toEqual(
      rejection("storage.unavailable", "released"),
    );
    expect(fx.reservations.size + fx.documents.size).toBe(0);
  });

  it("lost response after a landed write: head confirms, upload completes", async () => {
    const fx = fakeUpload();
    fx.faults.put = "commitThenFail";
    expect((await uploadDocument(fx, command())).outcome).toBe("created");
    expect(fx.log).toEqual(["tx", "put", "head", "tx"]);
  });

  it.each([
    ["head finds nothing", false],
    ["head itself fails", true],
  ])("unknown write outcome, %s: reservation kept for reconciliation", async (_n, headFails) => {
    const fx = fakeUpload();
    fx.faults.put = "failAfterBody";
    fx.faults.headFails = headFails;
    await expect(uploadDocument(fx, command())).rejects.toEqual(
      rejection("storage.unavailable", "retained"),
    );
    expect(fx.reservations.size).toBe(1);
    expect(fx.documents.size).toBe(0);
    expect(fx.log).not.toContain("delete");
  });

  it("an existing object under the key is never deleted", async () => {
    const fx = fakeUpload();
    const key = `ws/${actor.workspaceId}/doc/00000000-0000-4000-8000-000000000064/v/00000000-0000-4000-8000-000000000065`;
    fx.objects.set(key, enc("someone else's"));
    await expect(uploadDocument(fx, command())).rejects.toMatchObject({ code: "storage.conflict" });
    expect(fx.objects.get(key)).toEqual(enc("someone else's"));
    expect(fx.reservations.size).toBe(1);
  });
});

describe("finalization outcomes", () => {
  it("duplicate: deletes only its own object, releases, returns the existing document", async () => {
    const fx = fakeUpload();
    const first = await uploadDocument(fx, command());
    const [firstKey] = [...fx.objects.keys()];
    const second = await uploadDocument(fx, command());
    expect(second).toEqual({ outcome: "duplicate", document: first.document });
    expect([...fx.objects.keys()]).toEqual([firstKey]);
    expect(fx.documents.size + fx.reservations.size).toBe(1);
  });

  it("duplicate with a failed delete keeps the reservation and fails safely", async () => {
    const fx = fakeUpload();
    await uploadDocument(fx, command());
    fx.faults.deleteFails = true;
    await expect(uploadDocument(fx, command())).rejects.toEqual(
      rejection("storage.unavailable", "retained"),
    );
    expect(fx.reservations.size).toBe(1);
    expect(fx.objects.size).toBe(2);
  });

  it("duplicate whose release fails still answers (the object is confirmed gone)", async () => {
    const fx = fakeUpload();
    await uploadDocument(fx, command());
    fx.faults.releaseFails = true;
    expect((await uploadDocument(fx, command())).outcome).toBe("duplicate");
    expect(fx.objects.size).toBe(1);
  });

  it("quota at finalization: object deleted, reservation released", async () => {
    const fx = fakeUpload();
    fx.faults.finalize = "quota";
    await expect(uploadDocument(fx, command())).rejects.toEqual(
      rejection("upload.quota_bytes", "released"),
    );
    expect(fx.objects.size + fx.reservations.size).toBe(0);
  });

  it("a rollback reported by the repository: object deleted, reservation released", async () => {
    const fx = fakeUpload();
    fx.faults.finalize = "rolledBack";
    await expect(uploadDocument(fx, command())).rejects.toMatchObject({
      code: "upload.reservation_missing",
    });
    expect(fx.objects.size + fx.reservations.size + fx.documents.size).toBe(0);
  });

  it("an ambiguous failure with no document found keeps object and reservation", async () => {
    const fx = fakeUpload();
    fx.faults.finalize = "throw"; // lost connection: a commit may still be in flight
    await expect(uploadDocument(fx, command())).rejects.toThrow("connection lost");
    expect(fx.objects.size).toBe(1);
    expect(fx.reservations.size).toBe(1);
    expect(fx.log).not.toContain("delete");
  });

  it("an error after the commit is recognised: that document is returned, the object kept", async () => {
    const fx = fakeUpload();
    fx.faults.finalize = "throwAfterCommit";
    const result = await uploadDocument(fx, command());
    expect(result.outcome).toBe("created");
    expect([...fx.documents.keys()]).toEqual([result.document.id]);
    expect(fx.objects.size).toBe(1);
    expect(fx.log).not.toContain("delete");
  });

  it("recovery never mistakes another document with the same content for this upload", async () => {
    const fx = fakeUpload();
    const twin = await uploadDocument(fx, command());
    fx.faults.finalize = "rolledBack"; // the second upload's finalization fails, bytes identical
    await expect(uploadDocument(fx, command())).rejects.toMatchObject({
      code: "upload.reservation_missing",
    });
    expect([...fx.documents.keys()]).toEqual([twin.document.id]);
    expect(fx.objects.size).toBe(1); // the twin's object survives; only the new key was deleted
  });

  it("recovery ignores a document of another workspace that carries this id", async () => {
    const fx = fakeUpload();
    const ownId = parseDocumentId("00000000-0000-4000-8000-000000000064");
    fx.documents.set(ownId, {
      id: ownId,
      displayName: "x.pdf",
      mime: "application/pdf",
      sizeBytes: 1,
      status: "uploaded",
      createdAt: new Date(0),
      sha: "other",
      workspaceId: "00000000-0000-4000-8000-0000000000ff",
    });
    fx.faults.finalize = "throw";
    await expect(uploadDocument(fx, command())).rejects.toThrow("connection lost");
    expect(fx.objects.size).toBe(1); // not deleted, and not reported as created
    expect(fx.documents.size).toBe(1);
  });

  it("an unknowable commit outcome keeps both object and reservation", async () => {
    const fx = fakeUpload();
    fx.faults.finalize = "throw";
    fx.faults.readFails = true;
    await expect(uploadDocument(fx, command())).rejects.toThrow("connection lost");
    expect(fx.objects.size).toBe(1);
    expect(fx.reservations.size).toBe(1);
  });

  it("a failed cleanup after a rolled-back finalization leaves the reservation", async () => {
    const fx = fakeUpload();
    fx.faults.finalize = "rolledBack";
    fx.faults.deleteFails = true;
    await expect(uploadDocument(fx, command())).rejects.toMatchObject({
      code: "upload.reservation_missing",
    });
    expect(fx.objects.size).toBe(1);
    expect(fx.reservations.size).toBe(1);
  });

  it("an id conflict deletes nothing", async () => {
    const fx = fakeUpload();
    fx.faults.finalize = "conflict";
    await expect(uploadDocument(fx, command())).rejects.toMatchObject({ code: "upload.conflict" });
    expect(fx.log).not.toContain("delete");
  });
});

it("rejections carry fixed text only", async () => {
  const fx = fakeUpload();
  fx.faults.put = "refuse";
  const error = await uploadDocument(fx, command()).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UploadRejected);
  const text = error instanceof Error ? error.message : "";
  expect(text + JSON.stringify(error)).not.toMatch(/ws\/|report/);
});
