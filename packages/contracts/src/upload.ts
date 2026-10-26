// Raw-body upload contract shared by the web transport and (from M1.3e) the API:
//   POST /workspaces/{workspaceId}/uploads, body = the file bytes, nothing else.
// Headers describe the file; none of them is trusted beyond this shape check. The receiver of the
// bytes (the API) still counts what actually arrives and verifies the content.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const CONTENT_TYPES = ["application/pdf", "text/markdown", "text/plain"] as const;
type UploadContentType = (typeof CONTENT_TYPES)[number];

// Percent-encoded UTF-8 (what encodeURIComponent produces) is printable ASCII, so a header can
// carry any language. 255 decoded bytes, at most 3 encoded characters each.
const MAX_FILENAME_BYTES = 255;
const MAX_ENCODED_FILENAME = MAX_FILENAME_BYTES * 3;
const MAX_CONTENT_TYPE = 100;

export interface UploadHeaders {
  readonly contentType: UploadContentType;
  readonly contentLength: number;
  /** The `X-Filename` value exactly as received; it has been checked to decode, not decoded. */
  readonly encodedFilename: string;
}

export interface UploadRefusal {
  readonly status: number;
  readonly code: string;
}

export type UploadHeadersResult =
  | { readonly ok: true; readonly value: UploadHeaders }
  | { readonly ok: false; readonly refusal: UploadRefusal };

const refuse = (status: number, code: string): UploadHeadersResult => ({
  ok: false,
  refusal: { status, code },
});

function isContentType(value: string): value is UploadContentType {
  return CONTENT_TYPES.some((type) => type === value);
}

// Parameters (`; charset=...`) are dropped: the canonical bare type is what gets forwarded.
function canonicalContentType(raw: string | null): UploadContentType | undefined {
  if (raw === null || raw.length > MAX_CONTENT_TYPE) return undefined;
  const bare = (raw.split(";")[0] ?? "").trim().toLowerCase();
  return isContentType(bare) ? bare : undefined;
}

/** Decimal digits only: no sign, space, hex, exponent, or leading zeros. */
function declaredLength(raw: string): number | undefined {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(raw)) return undefined;
  return Number(raw);
}

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** The decoded display name, or undefined when the header is not a well-formed name. */
function decodeUploadFilename(raw: string | null): string | undefined {
  if (raw === null || raw.length === 0 || raw.length > MAX_ENCODED_FILENAME) return undefined;
  if (!/^[\x21-\x7e]+$/.test(raw)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (decoded.trim().length === 0 || hasControlCharacter(decoded)) return undefined;
  return utf8Length(decoded) <= MAX_FILENAME_BYTES ? decoded : undefined;
}

interface HeaderSource {
  get(name: string): string | null;
}

export function parseUploadHeaders(headers: HeaderSource): UploadHeadersResult {
  const rawLength = headers.get("content-length");
  // A chunked body has no declared length (411: tell the client to send one). Both together is the
  // classic request-smuggling shape and contradicts itself: refuse.
  if (headers.get("transfer-encoding") !== null) {
    return rawLength === null
      ? refuse(411, "upload.length_required")
      : refuse(400, "upload.invalid_length");
  }
  if (rawLength === null) return refuse(411, "upload.length_required");
  const contentLength = declaredLength(rawLength);
  if (contentLength === undefined) return refuse(400, "upload.invalid_length");
  if (contentLength === 0) return refuse(400, "upload.empty");
  if (contentLength > MAX_UPLOAD_BYTES) return refuse(413, "upload.too_large");
  const contentType = canonicalContentType(headers.get("content-type"));
  if (contentType === undefined) return refuse(415, "upload.unsupported_type");
  const encodedFilename = headers.get("x-filename");
  if (encodedFilename === null || decodeUploadFilename(encodedFilename) === undefined) {
    return refuse(400, "upload.invalid_name");
  }
  return { ok: true, value: { contentType, contentLength, encodedFilename } };
}
