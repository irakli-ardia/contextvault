import { describe, expect, it } from "vitest";
import { createContentVerifier } from "./content-verifier";
import { UploadRejected } from "./errors";

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => Uint8Array.from(Array.from(value, (c) => c.charCodeAt(0)));
const utf8 = (value: string) => {
  const out: number[] = [];
  for (const char of value) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
    }
  }
  return Uint8Array.from(out);
};

function verdict(mime: "application/pdf" | "text/plain", ...chunks: Uint8Array[]) {
  const verifier = createContentVerifier(mime);
  return () => {
    for (const chunk of chunks) verifier.update(chunk);
    verifier.finish();
  };
}
const mismatch = { code: "upload.content_mismatch" };

describe("pdf", () => {
  it("accepts %PDF- at offset zero, even split across chunks", () => {
    expect(verdict("application/pdf", text("%PDF-1.7 rest"))).not.toThrow();
    expect(verdict("application/pdf", text("%P"), text("DF"), text("-x"))).not.toThrow();
  });
  it.each([
    ["leading space", text(" %PDF-1.7")],
    ["wrong case", text("%pdf-1.7")],
    ["no dash", text("%PDF1.7")],
    ["too short", text("%PDF")],
    ["empty", bytes()],
  ])("rejects %s", (_name, body) => {
    expect(verdict("application/pdf", body)).toThrow(UploadRejected);
    expect(verdict("application/pdf", body)).toThrowError(expect.objectContaining(mismatch));
  });
});

describe("text", () => {
  it("accepts 2-, 3- and 4-byte characters back to back, and the sequence limits", () => {
    expect(verdict("text/plain", utf8("é€𝄞a"))).not.toThrow();
    const edges = [
      bytes(0xe0, 0xa0, 0x80),
      bytes(0xed, 0x9f, 0xbf),
      bytes(0xf0, 0x90, 0x80, 0x80),
      bytes(0xf4, 0x8f, 0xbf, 0xbf),
    ];
    for (const edge of edges) expect(verdict("text/plain", edge)).not.toThrow();
  });

  it("accepts multi-byte characters, including one split across every byte boundary", () => {
    const body = utf8("გამარჯობა €𝄞 ok\n");
    for (let cut = 1; cut < body.length; cut += 1) {
      expect(verdict("text/plain", body.slice(0, cut), body.slice(cut))).not.toThrow();
    }
  });
  it.each([
    ["NUL", bytes(0x61, 0x00)],
    ["stray continuation", bytes(0x80)],
    ["overlong slash", bytes(0xc0, 0xaf)],
    ["overlong 3-byte", bytes(0xe0, 0x80, 0x80)],
    ["surrogate", bytes(0xed, 0xa0, 0x80)],
    ["above U+10FFFF", bytes(0xf4, 0x90, 0x80, 0x80)],
    ["overlong 4-byte", bytes(0xf0, 0x80, 0x80, 0x80)],
    ["lead 0xf5", bytes(0xf5, 0x80, 0x80, 0x80)],
    ["lead 0xf8", bytes(0xf8, 0x80, 0x80, 0x80, 0x80)],
    ["2-byte lead cut by ASCII", bytes(0xc3, 0x61)],
    ["0xff", bytes(0xff)],
    ["truncated at the end", bytes(0x61, 0xe1, 0x83)],
    ["bad continuation", bytes(0xe1, 0x41, 0x80)],
  ])("rejects %s", (_name, body) => {
    expect(verdict("text/plain", body)).toThrowError(expect.objectContaining(mismatch));
  });
});
