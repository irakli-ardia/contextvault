import { describe, expect, it } from "vitest";
import { uploadDocument } from "./upload-document";
import { chunked, command, enc, fakeUpload, pdf, rejection } from "./upload-fakes";

describe("successful uploads", () => {
  it.each([
    ["report.pdf", "application/pdf", pdf],
    ["notes.md", "text/markdown", enc("# Title\n\nplain")],
    ["a.txt", "text/plain", enc("plain text\n")],
  ])("stores and finalizes %s", async (fileName, contentType, data) => {
    const fx = fakeUpload();
    const result = await uploadDocument(fx, command({ fileName, contentType }, data));
    expect(result.outcome).toBe("created");
    expect(result.document).toMatchObject({ displayName: fileName, mime: contentType });
    expect([...fx.objects.values()]).toEqual([data]);
    expect(fx.reservations.size).toBe(0);
  });

  it("opens no transaction during storage I/O and uses two short ones", async () => {
    const fx = fakeUpload();
    await uploadDocument(fx, command());
    expect(fx.log).toEqual(["tx", "put", "tx"]); // the fake store throws if called inside a tx
  });

  it("holds back at most one chunk of a 10 MiB body", async () => {
    const fx = fakeUpload();
    const size = 10 * 1024 * 1024;
    const data = new Uint8Array(size).fill(0x61);
    let pulled = 0;
    let received = 0;
    let worst = 0;
    async function* source() {
      for (let i = 0; i < size; i += 65536) {
        pulled += 1;
        yield data.subarray(i, i + 65536);
      }
    }
    const put = fx.store.put.bind(fx.store);
    fx.store.put = (key, body, length) =>
      put(
        key,
        (async function* () {
          for await (const chunk of body) {
            received += 1;
            worst = Math.max(worst, pulled - received);
            yield chunk;
          }
        })(),
        length,
      );
    const cmd = command(
      { fileName: "big.txt", contentType: "text/plain", declaredBytes: size, body: source() },
      data,
    );
    await uploadDocument(fx, cmd);
    expect(worst).toBeLessThanOrEqual(1);
  });
});

describe("rejected before anything is written", () => {
  it.each([
    ["invalid name", { fileName: "../x.exe" }, "upload.invalid_name"],
    ["extension and type disagree", { fileName: "a.txt" }, "upload.unsupported_type"],
    ["unknown type", { contentType: "image/png" }, "upload.unsupported_type"],
    ["zero length", { declaredBytes: 0 }, "upload.empty"],
    ["too large", { declaredBytes: 10 * 1024 * 1024 + 1 }, "upload.too_large"],
    ["fractional length", { declaredBytes: 1.5 }, "upload.invalid_length"],
    ["negative length", { declaredBytes: -1 }, "upload.invalid_length"],
  ])("%s", async (_name, over, code) => {
    const fx = fakeUpload();
    await expect(uploadDocument(fx, command(over))).rejects.toMatchObject({ code });
    expect(fx.log).toEqual([]);
  });

  it("refuses a reservation over quota without touching storage", async () => {
    const fx = fakeUpload();
    await expect(
      uploadDocument({ ...fx, quota: { maxDocuments: 0, maxBytes: 1 } }, command()),
    ).rejects.toMatchObject({ code: "upload.quota_documents", reservation: "none" });
    expect(fx.log).toEqual(["tx"]);
  });
});

describe("bad bodies leave no object and no reservation", () => {
  const utf8Tail = Uint8Array.from([0x61, 0x62, 0xe1]);
  it.each([
    ["not a PDF", command({}, enc("hello world!!")), "upload.content_mismatch"],
    ["fewer bytes than declared", command({ declaredBytes: pdf.length + 3 }), "upload.incomplete"],
    ["more bytes than declared", command({ declaredBytes: pdf.length - 3 }), "upload.incomplete"],
    [
      "invalid UTF-8 at the very end",
      command(
        { fileName: "a.txt", contentType: "text/plain", declaredBytes: 3, body: chunked(utf8Tail) },
        utf8Tail,
      ),
      "upload.content_mismatch",
    ],
  ])("%s", async (_name, cmd, code) => {
    const fx = fakeUpload();
    await expect(uploadDocument(fx, cmd)).rejects.toEqual(rejection(code, "released"));
    expect(fx.objects.size + fx.reservations.size + fx.documents.size).toBe(0);
    // The premise of "incomplete means absent": storage never saw the final declared byte.
    expect(fx.sent.bytes).toBeLessThan(cmd.declaredBytes);
  });

  it("handles a client that disconnects mid-stream", async () => {
    const fx = fakeUpload();
    async function* dies() {
      yield pdf.slice(0, 6);
      throw new Error("aborted");
    }
    await expect(uploadDocument(fx, command({ body: dies() }))).rejects.toEqual(
      rejection("upload.incomplete", "released"),
    );
    expect(fx.objects.size + fx.reservations.size).toBe(0);
  });

  it("deletes what a misbehaving provider kept of an aborted write before releasing", async () => {
    const fx = fakeUpload();
    fx.faults.put = "leakOnAbort";
    await expect(uploadDocument(fx, command({ declaredBytes: pdf.length + 3 }))).rejects.toEqual(
      rejection("upload.incomplete", "released"),
    );
    expect(fx.objects.size + fx.reservations.size).toBe(0);
    expect(fx.log).toContain("delete");
  });

  it("keeps the reservation when the absence cannot be confirmed", async () => {
    const fx = fakeUpload();
    fx.faults.put = "leakOnAbort";
    fx.faults.deleteFails = true;
    await expect(uploadDocument(fx, command({ declaredBytes: pdf.length + 3 }))).rejects.toEqual(
      rejection("upload.incomplete", "retained"),
    );
    expect(fx.reservations.size).toBe(1);
    expect(fx.objects.size).toBe(1);
  });

  it("keeps the reservation when releasing it fails", async () => {
    const fx = fakeUpload();
    fx.faults.releaseFails = true;
    await expect(uploadDocument(fx, command({ declaredBytes: 99 }))).rejects.toEqual(
      rejection("upload.incomplete", "retained"),
    );
    expect(fx.reservations.size).toBe(1);
  });
});
