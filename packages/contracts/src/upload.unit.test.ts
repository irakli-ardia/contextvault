import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, parseUploadHeaders } from "./index";

const valid: Record<string, string> = {
  "content-length": "1024",
  "content-type": "application/pdf",
  "x-filename": "report.pdf",
};

const parse = (overrides: Record<string, string | null> = {}) => {
  const merged = { ...valid, ...overrides };
  return parseUploadHeaders({ get: (name) => merged[name] ?? null });
};

const refusal = (overrides: Record<string, string | null>) => {
  const result = parse(overrides);
  return result.ok ? undefined : [result.refusal.status, result.refusal.code];
};

describe("parseUploadHeaders", () => {
  it("accepts the three types, with parameters and any case, and forwards the bare type", () => {
    for (const [sent, canonical] of [
      ["application/pdf", "application/pdf"],
      ["TEXT/Markdown", "text/markdown"],
      ["text/plain; charset=utf-8", "text/plain"],
    ] as const) {
      const result = parse({ "content-type": sent });
      expect(result.ok && result.value.contentType).toBe(canonical);
    }
  });

  it("accepts the limit exactly and refuses one byte more", () => {
    expect(parse({ "content-length": String(MAX_UPLOAD_BYTES) }).ok).toBe(true);
    expect(refusal({ "content-length": String(MAX_UPLOAD_BYTES + 1) })).toEqual([
      413,
      "upload.too_large",
    ]);
  });

  it("requires a Content-Length that is a plain decimal integer", () => {
    expect(refusal({ "content-length": null })).toEqual([411, "upload.length_required"]);
    expect(refusal({ "content-length": "0" })).toEqual([400, "upload.empty"]);
    for (const bad of ["", "abc", "-1", "+5", "1e3", "0x10", " 12", "12 ", "1,2", "01", "1.5"]) {
      expect([bad, refusal({ "content-length": bad })]).toEqual([
        bad,
        [400, "upload.invalid_length"],
      ]);
    }
    // Beyond Number's exact range: refused by shape, never rounded into range.
    expect(refusal({ "content-length": "9".repeat(30) })).toEqual([400, "upload.invalid_length"]);
  });

  it("answers 411 to a chunked body and 400 to Transfer-Encoding with Content-Length", () => {
    expect(refusal({ "transfer-encoding": "chunked", "content-length": null })).toEqual([
      411,
      "upload.length_required",
    ]);
    expect(refusal({ "transfer-encoding": "chunked" })).toEqual([400, "upload.invalid_length"]);
    expect(refusal({ "transfer-encoding": "identity" })).toEqual([400, "upload.invalid_length"]);
  });

  it("refuses other or missing content types", () => {
    for (const bad of [
      null,
      "",
      "multipart/form-data; boundary=x",
      "application/json",
      "text/html",
    ]) {
      expect([bad, refusal({ "content-type": bad })]).toEqual([
        bad,
        [415, "upload.unsupported_type"],
      ]);
    }
    expect(refusal({ "content-type": `text/plain;${"a".repeat(200)}` })?.[0]).toBe(415);
  });

  it("accepts percent-encoded names in any language and keeps the raw header", () => {
    for (const name of ["ხელშეკრულება.txt", "naïve résumé.md", "名前.pdf"]) {
      const encoded = encodeURIComponent(name);
      const result = parse({ "x-filename": encoded });
      expect(result.ok && result.value.encodedFilename).toBe(encoded);
    }
  });

  it("refuses names that are missing, malformed, controlled, empty, or too long", () => {
    const bad = [
      null,
      "",
      "a b.pdf", // a raw space is not part of the encoding
      "ხელ.pdf", // raw non-ASCII
      "%FF.pdf", // invalid UTF-8
      "%E0%A4%A.pdf", // truncated escape
      "a%00b.pdf",
      "a%0Ab.pdf",
      "a%7Fb.pdf",
      "a%C2%85b.pdf", // C1 control (NEL)
      "%20%20%20",
      "a".repeat(256),
      encodeURIComponent("ა".repeat(86)), // 258 UTF-8 bytes
      "x".repeat(800),
    ];
    for (const name of bad) {
      expect([name, refusal({ "x-filename": name })]).toEqual([name, [400, "upload.invalid_name"]]);
    }
  });

  it("checks length before type before name, so the cheapest refusal wins", () => {
    expect(
      refusal({
        "content-length": String(MAX_UPLOAD_BYTES + 1),
        "content-type": "x",
        "x-filename": "",
      }),
    ).toEqual([413, "upload.too_large"]);
    expect(refusal({ "content-type": "x", "x-filename": "" })).toEqual([
      415,
      "upload.unsupported_type",
    ]);
  });
});
