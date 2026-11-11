import { parseLimits } from "./limits";
import { ParseFailure } from "./parse-failure";
import type { ParsedDocument } from "./parsed-document";
import { parsePdf } from "./pdf";
import { parseText } from "./text";

const pdfSignature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/**
 * Runs inside the isolated child only. The format comes from the bytes: the upload verified that
 * the signature, MIME and extension agree, and the worker cannot read the MIME. Anything that is
 * not a PDF is parsed as UTF-8 text, which rejects binary content.
 */
export async function parseBytes(bytes: Uint8Array): Promise<ParsedDocument> {
  if (bytes.length === 0) throw new ParseFailure("parse.no_text");
  if (bytes.length > parseLimits.maxInputBytes) throw new ParseFailure("parse.corrupt");
  return pdfSignature.every((byte, i) => bytes[i] === byte) ? parsePdf(bytes) : parseText(bytes);
}
