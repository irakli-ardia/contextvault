import { loadS3Env } from "@contextvault/config";
import { type DocumentStore, StorageError } from "@contextvault/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  type Api,
  createTenantFixture,
  loginAs,
  seedAccount,
  startApi,
} from "../test-support";
import { UploadLimiter } from "./upload-limiter";
import { captureLogs, listen, must, pdfBytes, purge, rows, store, upload } from "./upload-support";

type Mode = "refuse" | "afterBody" | "hang" | "boom" | "conflict";
const fx = createTenantFixture(4);
const apis: Api[] = [];
let account: Account;
let workspaceId: string;
let token: string;
let real: DocumentStore;
const calls: string[] = [];

// Fault injection around the real SeaweedFS adapter: `head` and `delete` stay real unless a test
// says otherwise, so the database and bucket state asserted below is what really happened.
function faulty(mode: Mode, deleteFails = false): DocumentStore {
  return {
    async put(_key, body, _length, options) {
      calls.push("put");
      if (mode === "refuse") throw new StorageError("storage.unavailable", true);
      if (mode === "boom") throw new Error(`connect ECONNREFUSED ${loadS3Env().S3_ENDPOINT}`);
      if (mode === "conflict") throw new StorageError("storage.conflict", false);
      for await (const _chunk of body) {
        // The whole body flowed through verification; the last byte is now with the "provider".
      }
      await new Promise<void>((_resolve, reject) => {
        const fail = () => reject(new StorageError("storage.unavailable", true));
        if (mode === "afterBody") fail();
        else options?.signal?.addEventListener("abort", fail, { once: true });
      });
    },
    head: (key) => {
      calls.push("head");
      return real.head(key);
    },
    delete: async (key) => {
      calls.push("delete");
      if (deleteFails) throw new StorageError("storage.unavailable", true);
      return real.delete(key);
    },
  };
}

async function start(mode: Mode, options: { deleteFails?: boolean; totalMs?: number } = {}) {
  const started = await startApi(
    {},
    {
      store: faulty(mode, options.deleteFails),
      ...(options.totalMs ? { uploadTimeouts: { idleMs: 5_000, totalMs: options.totalMs } } : {}),
    },
  );
  await listen(started);
  apis.push(started);
  return started;
}

beforeAll(async () => {
  const first = await startApi();
  await listen(first);
  apis.push(first);
  real = store(first);
  account = await seedAccount(fx);
  workspaceId = await fx.createWorkspace(account.id, "Storage faults");
  token = (await loginAs(first, account)).token;
});
afterAll(async () => {
  await purge(must(apis[0]), fx, workspaceId);
  for (const a of apis) await a.app.close();
  await fx.close();
});

const secretName = "payroll-2026-confidential.pdf";
const send = (a: Api, seed: number) =>
  upload(a, { workspaceId, token, name: secretName }, pdfBytes(256, seed));

describe("storage failures", () => {
  it("a refused write: 503, object absent, reservation released, slot freed", async () => {
    const logs = captureLogs();
    const a = await start("refuse");
    const res = await send(a, 1);
    expect([res.status, res.json.error?.code]).toEqual([503, "storage.unavailable"]);
    expect(await rows(fx, workspaceId)).toEqual({ documents: 0, versions: 0, pending: 0 });
    expect(a.app.get(UploadLimiter).active).toBe(0);
    expect(logs.join("\n")).not.toContain("reservation_retained");
  });

  it("an unexpected provider error is sanitised and still releases everything", async () => {
    const logs = captureLogs();
    const a = await start("boom");
    const res = await send(a, 2);
    expect([res.status, res.json.error?.code]).toEqual([503, "storage.unavailable"]);
    expect(a.app.get(UploadLimiter).active).toBe(0);
    expect(res.text + logs.join("\n")).not.toContain("ECONNREFUSED");
  });

  it("a write whose outcome is unknown keeps the reservation and logs it once, with ids only", async () => {
    const logs = captureLogs();
    const a = await start("afterBody");
    calls.length = 0;
    const res = await send(a, 3);
    expect([res.status, res.json.error?.code]).toEqual([503, "storage.unavailable"]);
    expect(calls).toEqual(["put", "head"]); // asked, never deleted
    expect(await rows(fx, workspaceId)).toEqual({ documents: 0, versions: 0, pending: 1 });
    const [pending] = (
      await fx.owner.query("select id, storage_key from pending_uploads where workspace_id = $1", [
        workspaceId,
      ])
    ).rows;
    const retained = logs.filter((l) => l.includes("upload.reservation_retained"));
    expect(retained).toHaveLength(1);
    expect(JSON.parse(must(retained[0]))).toEqual({
      code: "upload.reservation_retained",
      requestId: res.json.error?.requestId,
      workspaceId,
      versionId: pending.id,
    });
    const everything = res.text + logs.join("\n");
    for (const secret of [
      pending.storage_key,
      secretName,
      "payroll",
      loadS3Env().S3_SECRET_ACCESS_KEY,
      loadS3Env().S3_ENDPOINT,
      token,
    ]) {
      expect(everything).not.toContain(secret);
    }
    await purge(must(apis[0]), fx, workspaceId);
  });

  it("the total deadline covers the wait after the last byte: 503, reservation retained, no delete", async () => {
    const logs = captureLogs();
    const a = await start("hang", { totalMs: 600 });
    calls.length = 0;
    const res = await send(a, 4);
    expect([res.status, res.json.error?.code]).toEqual([503, "storage.unavailable"]);
    expect(calls).toEqual(["put", "head"]);
    expect((await rows(fx, workspaceId)).pending).toBe(1);
    expect(logs.filter((l) => l.includes("upload.reservation_retained"))).toHaveLength(1);
    expect(a.app.get(UploadLimiter).active).toBe(0);
    await purge(must(apis[0]), fx, workspaceId);
  });

  it("an unconfirmed delete after a refusal keeps the reservation discoverable", async () => {
    const logs = captureLogs();
    const a = await start("refuse", { deleteFails: true });
    const res = await send(a, 5);
    expect(res.status).toBe(503);
    expect((await rows(fx, workspaceId)).pending).toBe(1);
    expect(logs.filter((l) => l.includes("upload.reservation_retained"))).toHaveLength(1);
    await purge(must(apis[0]), fx, workspaceId);
  });

  it("storage.conflict is an internal error (500) and never deletes", async () => {
    const a = await start("conflict");
    calls.length = 0;
    const res = await send(a, 6);
    expect([res.status, res.json.error?.code]).toEqual([500, "internal"]);
    expect(calls).toEqual(["put"]);
    expect((await rows(fx, workspaceId)).pending).toBe(1);
    await purge(must(apis[0]), fx, workspaceId);
  });

  it("a real upload still works after all of it", async () => {
    const res = await upload(must(apis[0]), { workspaceId, token }, pdfBytes(64, 7));
    expect(res.status).toBe(201);
  });
});
