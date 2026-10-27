import type { DocumentMime } from "./document";
import { UploadRejected } from "./errors";

const maxNameBytes = 255;
const mimeByExtension: Record<string, DocumentMime> = {
  pdf: "application/pdf",
  md: "text/markdown",
  txt: "text/plain",
};

// Each non-ASCII byte becomes one %XX escape, so collapsing escapes to one character counts bytes.
const utf8Length = (text: string): number =>
  encodeURIComponent(text.toWellFormed()).replace(/%[0-9A-F]{2}/g, "_").length;

/**
 * The display name and the type its extension implies. Display only: never part of a key, path,
 * log line, or SQL text. Takes the last path segment, drops control, format (bidi, zero-width) and
 * separator characters, and requires `.pdf`, `.md` or `.txt` after a non-empty base name.
 */
export function sanitizeFileName(raw: string): { name: string; mime: DocumentMime } {
  const lastSegment = raw.normalize("NFC").split(/[\\/]/).pop() ?? "";
  const name = lastSegment
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const dot = name.lastIndexOf(".");
  const mime = mimeByExtension[name.slice(dot + 1).toLowerCase()];
  if (dot < 1 || name.slice(0, dot).trim() === "" || utf8Length(name) > maxNameBytes) {
    throw new UploadRejected("upload.invalid_name");
  }
  if (mime === undefined) throw new UploadRejected("upload.invalid_name");
  return { name, mime };
}
