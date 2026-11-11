import { describe, expect, it } from "vitest";
import { parseLimits } from "./limits";
import { parseBytes } from "./parse-bytes";
import { buildEncryptedPdf, buildPdf } from "./pdf-test-support";

const utf8 = (text: string) => new TextEncoder().encode(text);
const code = async (bytes: Uint8Array) => {
  try {
    await parseBytes(bytes);
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : String(error);
  }
  return "parsed";
};

describe("text", () => {
  it("normalizes line endings, drops a BOM and keeps Unicode offsets", async () => {
    const doc = await parseBytes(utf8("﻿გამარჯობა\r\nworld\r! 😀"));
    expect(doc).toEqual({ format: "text", text: "გამარჯობა\nworld\n! 😀" });
  });

  it("rejects invalid UTF-8, NUL and empty or blank content with stable codes", async () => {
    expect(await code(new Uint8Array([0xc3, 0x28]))).toBe("parse.invalid_encoding");
    expect(await code(utf8("a\0b"))).toBe("parse.invalid_encoding");
    expect(await code(new Uint8Array())).toBe("parse.no_text");
    expect(await code(utf8(" \n\t "))).toBe("parse.no_text");
  });

  it("accepts exactly the character limit and refuses one more", async () => {
    const exact = "a".repeat(parseLimits.maxChars);
    expect((await parseBytes(utf8(exact))).text.length).toBe(parseLimits.maxChars);
    expect(await code(utf8(`${exact}a`))).toBe("parse.text_too_large");
  });
});

describe("pdf", () => {
  it("extracts text with ordered, non-overlapping page spans", async () => {
    const doc = await parseBytes(buildPdf(["Hello world", "Second page"]));
    expect(doc.format).toBe("pdf");
    if (doc.format !== "pdf") return;
    expect(doc.pages.map((p) => doc.text.slice(p.start, p.end).trim())).toEqual([
      "Hello world",
      "Second page",
    ]);
  });

  it("maps encrypted, truncated, garbage and scanned input to codes", async () => {
    expect(await code(buildEncryptedPdf())).toBe("parse.encrypted");
    expect(await code(buildPdf(["Hello world"]).subarray(0, 120))).toBe("parse.corrupt");
    expect(await code(utf8("%PDF-1.4 not really a pdf"))).toBe("parse.corrupt");
    expect(await code(buildPdf([""]))).toBe("parse.no_text");
  });

  it("accepts a Buffer, which is what the child reads from stdin", async () => {
    expect((await parseBytes(Buffer.from(buildPdf(["Hello"])))).format).toBe("pdf");
  });

  it("enforces the page limit before reading pages", async () => {
    const pages = Array.from({ length: parseLimits.maxPages + 1 }, (_, i) => `p${i}`);
    expect(await code(buildPdf(pages))).toBe("parse.too_many_pages");
    expect((await parseBytes(buildPdf(pages.slice(0, parseLimits.maxPages)))).format).toBe("pdf");
  });

  it("stops at the character limit", async () => {
    expect(await code(buildPdf(["x".repeat(parseLimits.maxChars + 1)]))).toBe(
      "parse.text_too_large",
    );
  });
});
