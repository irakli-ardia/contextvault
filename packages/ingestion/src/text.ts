import { parseLimits } from "./limits";
import { ParseFailure } from "./parse-failure";
import type { ParsedDocument } from "./parsed-document";

/** Strict UTF-8 (a BOM is dropped), no NUL, `\r\n` and `\r` become `\n`. */
export function parseText(bytes: Uint8Array): ParsedDocument {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ParseFailure("parse.invalid_encoding");
  }
  if (decoded.includes("\0")) throw new ParseFailure("parse.invalid_encoding");
  const text = decoded.replace(/\r\n?/g, "\n");
  if (text.length > parseLimits.maxChars) throw new ParseFailure("parse.text_too_large");
  if (text.trim() === "") throw new ParseFailure("parse.no_text");
  return { format: "text", text };
}
