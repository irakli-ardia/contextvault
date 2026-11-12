import { HttpError } from "../../lib/http-client";

// Stable API codes to guidance a person can act on. Unknown codes fall back to a generic line:
// the UI never shows a raw code or server text as the explanation.
const GUIDANCE = new Map([
  ["parse.encrypted", "This PDF is password-protected. Remove the password and upload it again."],
  [
    "parse.corrupt",
    "The file could not be read. Re-export it from the source and upload it again.",
  ],
  ["parse.no_text", "No text was found. Scanned or image-only PDFs are not supported yet."],
  ["parse.too_many_pages", "This PDF has too many pages. Split it and upload the parts."],
  ["parse.text_too_large", "This document holds too much text. Split it and upload the parts."],
  ["parse.invalid_encoding", "The text is not valid UTF-8. Save it as UTF-8 and upload it again."],
  ["parse.timeout", "Reading the file took too long. Try again, or upload a smaller file."],
  ["upload.empty", "The file is empty."],
  ["upload.too_large", "The file is larger than 10 MB."],
  [
    "upload.unsupported_type",
    "Only PDF, Markdown (.md) and plain text (.txt) files are supported.",
  ],
  ["upload.invalid_name", "The file name is not valid or is too long. Rename the file."],
  ["upload.content_mismatch", "The file contents do not match its type. Check the file and retry."],
  [
    "upload.quota_documents",
    "This workspace reached its document limit. Delete one to upload more.",
  ],
  ["upload.quota_bytes", "This workspace reached its storage limit. Delete a document first."],
  ["upload.busy", "Another upload is in progress. Wait for it, then try again."],
  ["upload.incomplete", "The upload was interrupted. Try again."],
  ["upload.idle_timeout", "The upload stalled. Check your connection and try again."],
  ["upload.deadline_exceeded", "The upload took too long. Check your connection and try again."],
  ["document.not_retryable", "This document cannot be retried. Upload a corrected file instead."],
  ["document.not_found", "This document no longer exists."],
  ["retry.throttled", "Too many retries. Wait a moment, then try again."],
  ["auth.unauthenticated", "Your session has ended. Sign in again."],
  ["permission.denied", "Your role in this workspace does not allow this action."],
  ["network.unavailable", "Cannot reach the server. Check your connection and try again."],
]);

const GENERIC = "Something went wrong. Try again in a moment.";

export const guidanceFor = (code: string): string => GUIDANCE.get(code) ?? GENERIC;

export function guidanceForError(error: unknown): string {
  if (!(error instanceof HttpError)) return GENERIC;
  if (error.status === 403) return guidanceFor("permission.denied");
  const base = guidanceFor(error.code);
  return error.retryAfterSeconds === null
    ? base
    : `${base} (Retry in ${error.retryAfterSeconds}s.)`;
}

export const isSessionEnded = (error: unknown): boolean =>
  error instanceof HttpError && error.status === 401;
