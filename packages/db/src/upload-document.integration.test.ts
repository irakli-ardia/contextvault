import { createHash, randomUUID } from "node:crypto";
import {
  type Actor,
  type DocumentStore,
  parseDocumentVersionId,
  StorageError,
  type UploadDocumentCommand,
  type UploadServices,
  type UserId,
  uploadDocument,
  type WorkspaceId,
} from "@contextvault/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenantFixture } from "./tenant-fixture";

const fx = createTenantFixture(12);
const uow = fx.persistence.unitOfWork;

const services: UploadServices = {
  newId: randomUUID,
  newSha256() {
    const hash = createHash("sha256");
    return { update: (chunk) => void hash.update(chunk), digest: () => hash.digest() };
  },
};

// In-memory object store; create-only like the S3 adapter, with switchable faults.
function memoryStore() {
  const objects = new Map<string, Uint8Array>();
  const faults = { deleteFails: false };
  let calls = 0;
  const store: DocumentStore = {
    async put(key, body) {
      calls += 1;
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      if (objects.has(key)) throw new StorageError("storage.conflict", false);
      objects.set(key, Buffer.concat(chunks));
    },
    head: async (key) => {
      const found = objects.get(key);
      return found === undefined ? null : { length: found.length };
    },
    async delete(key) {
      if (faults.deleteFails) throw new StorageError("storage.unavailable", true);
      objects.delete(key);
    },
  };
  return { store, objects, faults, calls: () => calls };
}

let user: UserId;
beforeAll(async () => {
  user = await fx.seedUser();
});
afterAll(() => fx.close());

const actorIn = (workspaceId: WorkspaceId, userId = user): Actor => ({
  userId,
  workspaceId,
  role: "owner",
});
async function* chunks(data: Buffer, size = 7): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}
const pdf = (seed: string) => Buffer.from(`%PDF-1.7 ${seed}`);
const upload = (data: Buffer, who: Actor, name = "doc.pdf"): UploadDocumentCommand => ({
  actor: who,
  fileName: name,
  contentType: "application/pdf",
  declaredBytes: data.length,
  body: chunks(data),
});
const pending = (w: WorkspaceId) =>
  uow.run({ userId: user, workspaceId: w }, (r) =>
    r.uploads.listPendingUploads(w, new Date(Date.now() + 60_000), 50),
  );
const documentCount = async (w: WorkspaceId) =>
  (await uow.run({ userId: user, workspaceId: w }, (r) => r.documents.list(w, 50))).length;

describe("uploadDocument against Postgres", () => {
  it("stores the object and records the real SHA-256 and size", async () => {
    const w = await fx.createWorkspace(user);
    const m = memoryStore();
    const data = pdf("hash me");
    const result = await uploadDocument(
      { uow, store: m.store, services },
      upload(data, actorIn(w)),
    );
    expect(result).toMatchObject({ outcome: "created", document: { sizeBytes: data.length } });
    const [row] = await fx.owner
      .query<{ h: string }>(
        "select encode(content_sha256, 'hex') as h from documents where workspace_id = $1",
        [w],
      )
      .then((r) => r.rows);
    expect(row?.h).toBe(createHash("sha256").update(data).digest("hex"));
    expect([...m.objects.values()].map((o) => Buffer.from(o).equals(data))).toEqual([true]);
    expect(await pending(w)).toEqual([]);
  });

  it("concurrent identical uploads create one document and leave one object", async () => {
    const w = await fx.createWorkspace(user);
    const m = memoryStore();
    const data = pdf("same bytes");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        uploadDocument({ uow, store: m.store, services }, upload(data, actorIn(w))),
      ),
    );
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(new Set(results.map((r) => r.document.id)).size).toBe(1);
    expect(m.objects.size).toBe(1);
    expect(await documentCount(w)).toBe(1);
    expect(await pending(w)).toEqual([]);
  });

  it("deduplicates per workspace, never across workspaces", async () => {
    const [a, b] = [await fx.createWorkspace(user), await fx.createWorkspace(user)] as const;
    const m = memoryStore();
    const data = pdf("tenant scoped");
    const first = await uploadDocument({ uow, store: m.store, services }, upload(data, actorIn(a)));
    const second = await uploadDocument(
      { uow, store: m.store, services },
      upload(data, actorIn(b)),
    );
    expect([first.outcome, second.outcome]).toEqual(["created", "created"]);
    expect(m.objects.size).toBe(2);
  });

  it("refuses a user who is not a member before any object is written", async () => {
    const w = await fx.createWorkspace(user);
    const outsider = await fx.seedUser();
    const m = memoryStore();
    await expect(
      uploadDocument(
        { uow, store: m.store, services },
        upload(pdf("x"), { ...actorIn(w, outsider) }),
      ),
    ).rejects.toMatchObject({ code: "workspace.access_denied" });
    expect(m.calls()).toBe(0);
    expect(await pending(w)).toEqual([]);
  });

  // Runs the real unit of work, but misbehaves on the second transaction (finalization).
  const finalizeFaults = (w: WorkspaceId, mode: "rollback" | "ackLost" | "swept"): typeof uow => {
    let runs = 0;
    return {
      async run(context, work) {
        runs += 1;
        if (runs !== 2) return uow.run(context, work);
        if (mode === "swept") {
          const [row] = await pending(w);
          await uow.run(context, (r) =>
            r.uploads.releaseUpload(w, row?.versionId ?? parseDocumentVersionId(randomUUID())),
          );
          return uow.run(context, work);
        }
        if (mode === "rollback") {
          return uow.run(context, async (repos) => {
            await work(repos);
            throw new Error("connection lost"); // tx 2 rolls back after its writes
          });
        }
        await uow.run(context, work); // ackLost: it did commit
        throw new Error("commit acknowledgement lost");
      },
    };
  };

  it("an ambiguous failure after a real rollback keeps object and reservation", async () => {
    const w = await fx.createWorkspace(user);
    const m = memoryStore();
    await expect(
      uploadDocument(
        { uow: finalizeFaults(w, "rollback"), store: m.store, services },
        upload(pdf("rollback"), actorIn(w)),
      ),
    ).rejects.toThrow("connection lost");
    expect(await documentCount(w)).toBe(0);
    expect(m.objects.size).toBe(1);
    expect(await pending(w)).toHaveLength(1); // discoverable for reconciliation
  });

  it("a lost commit acknowledgement is recovered: this upload's document and version, object kept", async () => {
    const w = await fx.createWorkspace(user);
    const m = memoryStore();
    const result = await uploadDocument(
      { uow: finalizeFaults(w, "ackLost"), store: m.store, services },
      upload(pdf("ack lost"), actorIn(w)),
    );
    expect(result.outcome).toBe("created");
    const versions = await fx.owner
      .query<{ storage_key: string; document_id: string }>(
        "select storage_key, document_id from document_versions where workspace_id = $1",
        [w],
      )
      .then((r) => r.rows);
    expect(versions.map((v) => v.document_id)).toEqual([result.document.id]);
    expect([...m.objects.keys()]).toEqual(versions.map((v) => v.storage_key));
    expect(await pending(w)).toEqual([]);
  });

  it("a reservation swept before finalization rolls back for real: object deleted, nothing left", async () => {
    const w = await fx.createWorkspace(user);
    const m = memoryStore();
    await expect(
      uploadDocument(
        { uow: finalizeFaults(w, "swept"), store: m.store, services },
        upload(pdf("swept"), actorIn(w)),
      ),
    ).rejects.toMatchObject({ code: "upload.reservation_missing" });
    expect(await documentCount(w)).toBe(0);
    expect(m.objects.size).toBe(0);
    expect(await pending(w)).toEqual([]);
  });

  it("a failed delete after a duplicate keeps a discoverable reservation", async () => {
    const w = await fx.createWorkspace(user);
    const m = memoryStore();
    const data = pdf("dup cleanup");
    await uploadDocument({ uow, store: m.store, services }, upload(data, actorIn(w)));
    m.faults.deleteFails = true;
    await expect(
      uploadDocument({ uow, store: m.store, services }, upload(data, actorIn(w))),
    ).rejects.toMatchObject({ code: "storage.unavailable", reservation: "retained" });
    const left = await pending(w);
    expect(left).toHaveLength(1);
    expect(m.objects.has(left[0]?.storageKey ?? "")).toBe(true);
    expect(await documentCount(w)).toBe(1);
  });

  it("refuses over quota before storage and keeps usage unchanged", async () => {
    const w = await fx.createWorkspace(user);
    const m = memoryStore();
    const deps = { uow, store: m.store, services, quota: { maxDocuments: 1, maxBytes: 1 << 20 } };
    await uploadDocument(deps, upload(pdf("one"), actorIn(w)));
    const calls = m.calls();
    await expect(uploadDocument(deps, upload(pdf("two"), actorIn(w)))).rejects.toMatchObject({
      code: "upload.quota_documents",
    });
    expect(m.calls()).toBe(calls);
    expect(await pending(w)).toEqual([]);
  });

  it("leaves nothing behind for a truncated body", async () => {
    const w = await fx.createWorkspace(user);
    const m = memoryStore();
    const data = pdf("truncated");
    await expect(
      uploadDocument(
        { uow, store: m.store, services },
        { ...upload(data, actorIn(w)), declaredBytes: data.length + 5 },
      ),
    ).rejects.toMatchObject({ code: "upload.incomplete", reservation: "released" });
    expect(m.objects.size).toBe(0);
    expect(await pending(w)).toEqual([]);
  });
});
