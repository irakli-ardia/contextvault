import { readFileSync } from "node:fs";
import { MAX_UPLOAD_BYTES } from "@contextvault/contracts";
import { anonymousStatus, listKeys, objectState, S3_SECRET_ACCESS_KEY } from "./s3-state";
import { browserApi, expect, firstWorkspaceId, signIn, test } from "./support";
import {
  browserUpload,
  hold,
  must,
  pdf,
  raw,
  reservations,
  sha,
  stored,
  web,
} from "./upload-api-support";

// Real Chromium -> real Next -> real NestJS -> real PostgreSQL -> private SeaweedFS.
const secretName = "payroll-2026-confidential";

test.describe("upload through the whole stack", () => {
  test.describe.configure({ mode: "serial" });

  test("PDF, Markdown and text are stored privately; duplicates and other workspaces behave", async ({
    page,
    browser,
    accounts: [ada, bea],
  }) => {
    await signIn(page, ada);
    const adaWs = firstWorkspaceId((await browserApi(page, "GET", "/api/auth/me")).body);
    const beaPage = await (await browser.newContext({ baseURL: web })).newPage();
    await signIn(beaPage, bea);
    const beaWs = firstWorkspaceId((await browserApi(beaPage, "GET", "/api/auth/me")).body);

    const files = [
      { name: `${secretName}.pdf`, type: "application/pdf", bytes: pdf(1) },
      { name: "notes.md", type: "text/markdown", bytes: Buffer.from("# Hello\n\nგამარჯობა\n") },
      { name: "plain.txt", type: "text/plain", bytes: Buffer.from("plain text\n") },
    ];
    for (const file of files) {
      const res = await browserUpload(page, adaWs, file);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        displayName: file.name,
        sizeBytes: file.bytes.length,
        status: "uploaded",
      });
      expect(res.text).not.toContain("storageKey");
      const row = stored(adaWs).find((d) => d.id === res.body.id);
      expect(row).toMatchObject({
        mime: file.type,
        sizeBytes: file.bytes.length,
        sha256: sha(file.bytes),
      });
      expect(row?.storageKey).toMatch(
        new RegExp(`^ws/${adaWs}/doc/${res.body.id}/v/[0-9a-f-]{36}$`),
      );
      expect(objectState(row?.storageKey ?? "")).toEqual({
        status: 200,
        length: file.bytes.length,
      });
      expect(anonymousStatus(row?.storageKey ?? "")).toBe(403);
    }

    // The same bytes again: the existing document, no second object.
    const first = must(stored(adaWs)[0]);
    const [pdfFile] = files;
    const again = await browserUpload(page, adaWs, { ...must(pdfFile), name: "renamed.pdf" });
    expect([again.status, again.body.id]).toEqual([200, first.id]);
    expect(stored(adaWs)).toHaveLength(3);

    // The same bytes in another workspace: independent document and object.
    const other = await browserUpload(beaPage, beaWs, must(pdfFile));
    expect(other.status).toBe(201);
    expect(other.body.id).not.toBe(first.id);
    const theirs = stored(beaWs);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.storageKey).not.toBe(first.storageKey);
    expect(theirs[0]?.storageKey.startsWith(`ws/${beaWs}/`)).toBe(true);

    // A foreign workspace is indistinguishable from a missing one, and writes nothing.
    const foreign = await browserUpload(page, beaWs, {
      name: "x.pdf",
      type: "application/pdf",
      bytes: pdf(9),
    });
    const missing = await browserUpload(page, "6f1c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5", {
      name: "x.pdf",
      type: "application/pdf",
      bytes: pdf(9),
    });
    expect([foreign.status, foreign.body.error.code]).toEqual([404, "not_found"]);
    expect([missing.status, missing.body.error.code]).toEqual([404, "not_found"]);
    expect(stored(beaWs)).toHaveLength(1);
    await beaPage.context().close();
  });

  test("rejections leave neither a row nor an object", async ({ page, accounts: [ada] }) => {
    await signIn(page, ada);
    const ws = firstWorkspaceId((await browserApi(page, "GET", "/api/auth/me")).body);
    const before = stored(ws).length;
    const bad = [
      { name: "a.pdf", type: "application/pdf", bytes: Buffer.from("NOTPDF-1.7 hello") },
      { name: "a.txt", type: "text/plain", bytes: Buffer.from([0x68, 0xff, 0xfe]) },
    ];
    for (const file of bad) {
      const res = await browserUpload(page, ws, file);
      expect([res.status, res.body.error.code]).toEqual([422, "upload.content_mismatch"]);
    }
    const big = await browserUpload(page, ws, {
      name: "big.pdf",
      type: "application/pdf",
      size: MAX_UPLOAD_BYTES + 1,
    });
    expect([big.status, big.body.error.code]).toEqual([413, "upload.too_large"]);
    expect(stored(ws)).toHaveLength(before);
  });

  test("a truncated body, a forged Origin and a missing session are refused", async ({
    page,
    context,
    request,
    accounts: [ada],
  }) => {
    await signIn(page, ada);
    const ws = firstWorkspaceId((await browserApi(page, "GET", "/api/auth/me")).body);
    const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const documents = stored(ws);
    const keysBefore = documents.map((d) => d.storageKey).sort();
    expect(reservations(ws)).toEqual([]);
    expect(listKeys(`ws/${ws}/`).sort()).toEqual(keysBefore);

    // Declares 4 KiB and sends 40 bytes. Wait until the API has really reserved it (state, not
    // time), then drop the connection: the abort travels web -> API -> storage.
    const partial = hold(cookie, ws, 4096, pdf(3).subarray(0, 40));
    await expect
      .poll(() => reservations(ws).map((r) => r.declaredBytes), { timeout: 10_000 })
      .toEqual([4096]);
    partial.abort();
    await expect.poll(() => reservations(ws), { timeout: 10_000 }).toEqual([]);

    // No document, no completed object, and the reservation (quota) was released, not leaked.
    expect(stored(ws)).toEqual(documents);
    expect(listKeys(`ws/${ws}/`).sort()).toEqual(keysBefore);

    expect(
      await raw(cookie, ws, {
        origin: "https://evil.example",
        declared: 10,
        send: pdf(3).subarray(0, 10),
      }),
    ).toBe(403);
    const anonymous = await request.post(`/api/workspaces/${ws}/uploads`, {
      headers: { origin: web, "content-type": "application/pdf", "x-filename": "a.pdf" },
      data: pdf(4),
    });
    expect(anonymous.status()).toBe(401);

    // The freed slot and quota are usable at once.
    const ok = await browserUpload(page, ws, {
      name: "after.pdf",
      type: "application/pdf",
      bytes: pdf(5),
    });
    expect(ok.status).toBe(201);
    expect(stored(ws)).toHaveLength(documents.length + 1);
    expect(reservations(ws)).toEqual([]);
  });

  test("no log line carries a file name, a storage key, a hash or the S3 secret", async ({
    accounts: [ada],
  }) => {
    const logs = ["playwright-report/api.log", "playwright-report/web.log"]
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(logs).not.toContain(secretName);
    expect(logs).not.toMatch(/ws\/[0-9a-f-]{36}\/doc\//);
    expect(logs).not.toMatch(/[0-9a-f]{64}/);
    expect(logs).not.toContain(ada.password);
    expect(logs).not.toContain(S3_SECRET_ACCESS_KEY);
  });
});
