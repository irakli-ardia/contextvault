import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  type Api,
  createTenantFixture,
  seedAccount,
  startApi,
} from "../test-support";
import {
  captureLogs,
  listen,
  pdfBytes,
  purge,
  rows,
  sha256,
  signedIn,
  startUpload,
  store,
  storedKeys,
  type UploadOptions,
  upload,
} from "./upload-support";

const fx = await createTenantFixture(6);
let api: Api;
let ada: { account: Account; workspaceId: string; token: string };
let bea: { account: Account; workspaceId: string; token: string };

beforeAll(async () => {
  api = await startApi();
  await listen(api);
  ada = await signedIn(api, fx, () => seedAccount(fx));
  bea = await signedIn(api, fx, () => seedAccount(fx));
});
afterAll(async () => {
  for (const w of [ada.workspaceId, bea.workspaceId]) await purge(api, fx, w);
  await api.app.close();
  await fx.close();
});

const mine = (name: string, type: string) => ({ ...ada, name, type });

describe("a valid upload", () => {
  it.each([
    ["report.pdf", "application/pdf", pdfBytes()],
    ["notes.md", "text/markdown", Buffer.from("# Héllo\n\nგამარჯობა\n")],
    ["plain.txt", "text/plain; charset=utf-8", Buffer.from("just text\n")],
  ])("stores %s privately and records it", async (name, type, body) => {
    const res = await upload(api, mine(name, type), body);
    expect(res.status).toBe(201);
    expect(res.headers.connection).toBe("close");
    expect(Object.keys(res.json).sort()).toEqual(
      ["createdAt", "displayName", "id", "mime", "sizeBytes", "status"].sort(),
    );
    expect(res.json).toMatchObject({
      displayName: name,
      sizeBytes: body.length,
      status: "uploaded",
    });
    const [row] = (
      await fx.fixture.query(
        "select d.content_sha256, v.storage_key, v.status from documents d join document_versions v on v.document_id = d.id where d.id = $1",
        [res.json.id],
      )
    ).rows;
    expect(row.content_sha256.toString("hex")).toBe(sha256(body));
    expect(row.status).toBe("uploaded");
    expect(await store(api).head(row.storage_key)).toEqual({ length: body.length });
    expect(res.text).not.toContain(row.storage_key);
    expect((await rows(fx, ada.workspaceId)).pending).toBe(0);
  });
});

describe("duplicates and isolation", () => {
  it("the same bytes again return the existing document and keep one object", async () => {
    const body = pdfBytes(900, 0x44);
    const first = await upload(api, mine("a.pdf", "application/pdf"), body);
    const before = (await storedKeys(fx, ada.workspaceId)).length;
    const again = await upload(api, mine("other-name.pdf", "application/pdf"), body);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.json.id).toBe(first.json.id);
    expect(again.json.displayName).toBe("a.pdf");
    expect((await storedKeys(fx, ada.workspaceId)).length).toBe(before);
    expect((await rows(fx, ada.workspaceId)).pending).toBe(0);
  });

  it("identical content in another workspace is a separate document", async () => {
    const body = pdfBytes(700, 0x45);
    const a = await upload(api, mine("a.pdf", "application/pdf"), body);
    const b = await upload(api, { ...bea, name: "a.pdf" }, body);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.json.id).not.toBe(a.json.id);
    const [{ n }] = (
      await fx.fixture.query(
        "select count(*)::int n from documents where content_sha256 = decode($1, 'hex')",
        [sha256(body)],
      )
    ).rows;
    expect(n).toBe(2);
  });
});

describe("a rejected upload leaves nothing behind", () => {
  const cases: Array<[string, string, string, Buffer, number, string]> = [
    [
      "bad PDF signature",
      "x.pdf",
      "application/pdf",
      Buffer.from("NOTPDF-1.7 hello"),
      422,
      "upload.content_mismatch",
    ],
    [
      "invalid UTF-8",
      "x.txt",
      "text/plain",
      Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]),
      422,
      "upload.content_mismatch",
    ],
    ["NUL in text", "x.md", "text/markdown", Buffer.from("a\0b"), 422, "upload.content_mismatch"],
    [
      "type and extension disagree",
      "x.pdf",
      "text/plain",
      Buffer.from("hello"),
      415,
      "upload.unsupported_type",
    ],
    [
      "unsupported type",
      "x.pdf",
      "image/png",
      Buffer.from("hello"),
      415,
      "upload.unsupported_type",
    ],
    [
      "extension not allowed",
      "x.exe",
      "text/plain",
      Buffer.from("hello"),
      400,
      "upload.invalid_name",
    ],
  ];
  it.each(cases)("%s", async (_n, name, type, body, status, code) => {
    const logs = captureLogs();
    const before = await rows(fx, ada.workspaceId);
    const keys = await storedKeys(fx, ada.workspaceId);
    const res = await upload(api, { ...ada, name, type }, body);
    expect([res.status, res.json.error?.code]).toEqual([status, code]);
    expect(await rows(fx, ada.workspaceId)).toEqual(before);
    expect(await storedKeys(fx, ada.workspaceId)).toEqual(keys);
    expect(res.text + logs.join("\n")).not.toContain(name);
  });

  it("an oversized declaration is refused before any storage work", async () => {
    const before = await rows(fx, ada.workspaceId);
    const sending = startUpload(api, { ...ada, declared: 10 * 1024 * 1024 + 1 });
    sending.end();
    const res = await sending.result;
    expect([res.status, res.json.error?.code]).toEqual([413, "upload.too_large"]);
    expect(res.headers.connection).toBe("close");
    expect(await rows(fx, ada.workspaceId)).toEqual(before);
  });

  it.each([
    [
      "missing Content-Length",
      { headers: { "transfer-encoding": "chunked" } },
      411,
      "upload.length_required",
    ],
    ["zero length", { declared: 0 }, 400, "upload.empty"],
    [
      "a name with control characters",
      { name: "a\u0007b.pdf", declared: 5 },
      400,
      "upload.invalid_name",
    ],
  ])("%s", async (_n, extra: Partial<UploadOptions>, status, code) => {
    const sending = startUpload(api, { ...ada, ...extra });
    sending.end(Buffer.alloc(extra.declared ?? 0, 0x41));
    const res = await sending.result;
    expect([res.status, res.json.error?.code]).toEqual([status, code]);
  });

  it("a body longer than declared never reaches storage as one object", async () => {
    const before = await storedKeys(fx, ada.workspaceId);
    const body = Buffer.concat([pdfBytes(100), randomBytes(50)]);
    const sending = startUpload(api, { ...ada, declared: 60 });
    sending.end(body);
    await sending.result.catch(() => undefined);
    expect(await storedKeys(fx, ada.workspaceId)).toEqual(before);
    expect((await rows(fx, ada.workspaceId)).pending).toBe(0);
  });
});
