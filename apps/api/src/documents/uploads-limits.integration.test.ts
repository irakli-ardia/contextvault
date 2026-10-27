import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type Account,
  type Api,
  createTenantFixture,
  loginAs,
  seedAccount,
  startApi,
} from "../test-support";
import { UploadLimiter } from "./upload-limiter";
import {
  captureLogs,
  listen,
  must,
  pdfBytes,
  purge,
  rows,
  startUpload,
  upload,
} from "./upload-support";

interface Member {
  account: Account;
  workspaceId: string;
  token: string;
}
const fx = await createTenantFixture(4);
const apis: Api[] = [];
let api: Api;
let members: Member[];

async function start(timeouts?: { idleMs: number; totalMs: number }): Promise<Api> {
  const started = await startApi({}, timeouts ? { uploadTimeouts: timeouts } : {});
  await listen(started);
  apis.push(started);
  return started;
}
const active = (a: Api) => a.app.get(UploadLimiter).active;
const held = (a: Api, m: Member, name: string) =>
  startUpload(a, { ...m, name, declared: 4096 }, pdfBytes(64, 0x61));

beforeAll(async () => {
  api = await start();
  members = [];
  for (let i = 0; i < 5; i++) {
    const account = await seedAccount(fx);
    const workspaceId = await fx.createWorkspace(account.id, `Limits ${i}`);
    members.push({ account, workspaceId, token: (await loginAs(api, account)).token });
  }
});
afterAll(async () => {
  for (const m of members) await purge(api, fx, m.workspaceId);
  for (const a of apis) await a.app.close();
  await fx.close();
});

describe("in-flight limits", () => {
  it("allows 2 per user, answers the 3rd with 429 and frees the slot when the first ends", async () => {
    const ada = must(members[0]);
    const bea = must(members[1]);
    const first = held(api, ada, "a.pdf");
    const second = held(api, ada, "b.pdf");
    await vi.waitFor(() => expect(active(api)).toBe(2));
    const third = await upload(api, { ...ada, name: "c.pdf" }, pdfBytes(10, 0x62));
    expect([third.status, third.json.error?.code]).toEqual([429, "upload.busy"]);
    expect(third.headers["retry-after"]).toBeDefined();
    // Another user is not affected.
    expect((await upload(api, { ...bea, name: "d.pdf" }, pdfBytes(10, 0x63))).status).toBe(201);
    first.abort();
    await vi.waitFor(() => expect(active(api)).toBe(1));
    expect((await upload(api, { ...ada, name: "e.pdf" }, pdfBytes(10, 0x64))).status).toBe(201);
    second.abort();
    await vi.waitFor(() => expect(active(api)).toBe(0));
    expect(await rows(fx, ada.workspaceId)).toMatchObject({ pending: 0 });
  });

  it("allows 8 per process whoever asks, and every disconnect releases its slot", async () => {
    const logs = captureLogs();
    const holders = members
      .slice(0, 4)
      .flatMap((m, i) => [held(api, m, `${i}a.pdf`), held(api, m, `${i}b.pdf`)]);
    await vi.waitFor(() => expect(active(api)).toBe(8));
    const fifth = must(members[4]);
    const over = await upload(api, { ...fifth, name: "z.pdf" }, pdfBytes(10, 0x65));
    expect([over.status, over.json.error?.code]).toEqual([429, "upload.busy"]);
    for (const h of holders) h.abort();
    await vi.waitFor(() => expect(active(api)).toBe(0));
    expect(logs.join("\n")).toContain("upload.client_disconnected");
    for (const m of members.slice(0, 4)) {
      expect(await rows(fx, m.workspaceId)).toEqual({
        documents: expect.any(Number),
        versions: expect.any(Number),
        pending: 0,
      });
    }
    expect((await upload(api, { ...fifth, name: "z.pdf" }, pdfBytes(10, 0x65))).status).toBe(201);
  });

  it("releases the slot after a rejection", async () => {
    const ada = must(members[0]);
    const res = await upload(api, { ...ada, name: "bad.pdf" }, Buffer.from("not a pdf"));
    expect(res.status).toBe(422);
    expect(active(api)).toBe(0);
  });
});

describe("deadlines", () => {
  it("an idle upload ends with 400 upload.incomplete, nothing stored, slot released", async () => {
    const logs = captureLogs();
    const quick = await start({ idleMs: 250, totalMs: 20_000 });
    const ada = must(members[0]);
    const before = await rows(fx, ada.workspaceId);
    const sending = held(quick, ada, "idle.pdf");
    const res = await sending.result;
    expect([res.status, res.json.error?.code]).toEqual([400, "upload.incomplete"]);
    expect(res.headers.connection).toBe("close");
    expect(await rows(fx, ada.workspaceId)).toEqual(before);
    expect(active(quick)).toBe(0);
    expect(logs.join("\n")).toContain("upload.idle_timeout");
  });

  it("the total deadline ends an upload that keeps trickling", async () => {
    const logs = captureLogs();
    const slow = await start({ idleMs: 5_000, totalMs: 500 });
    const ada = must(members[0]);
    const sending = held(slow, ada, "slow.pdf");
    const trickle = setInterval(() => sending.write(Buffer.from("A")), 100);
    const res = await sending.result.finally(() => clearInterval(trickle));
    expect([res.status, res.json.error?.code]).toEqual([400, "upload.incomplete"]);
    expect(active(slow)).toBe(0);
    expect(logs.join("\n")).toContain("upload.deadline_exceeded");
    expect((await rows(fx, ada.workspaceId)).pending).toBe(0);
  });
});
