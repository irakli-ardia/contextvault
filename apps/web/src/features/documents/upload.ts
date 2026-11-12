import { MAX_UPLOAD_BYTES, parseApiErrorBody } from "@contextvault/contracts";
import { HttpError } from "../../lib/http-client";

const TYPES = new Map([
  ["pdf", "application/pdf"],
  ["md", "text/markdown"],
  ["markdown", "text/markdown"],
  ["txt", "text/plain"],
]);
const MAX_NAME_BYTES = 255;

export type UploadCheck =
  | { readonly ok: true; readonly contentType: string }
  | { readonly ok: false; readonly code: string };

const extensionOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/** Mirrors the server's header checks so an obviously bad file never leaves the browser. */
export function checkUpload(file: { name: string; size: number }): UploadCheck {
  // Extension, not `file.type`: browsers report no type for Markdown. The API sniffs the content.
  const contentType = TYPES.get(extensionOf(file.name));
  const code = [
    [file.size === 0, "upload.empty"],
    [file.size > MAX_UPLOAD_BYTES, "upload.too_large"],
    [
      new TextEncoder().encode(file.name).length > MAX_NAME_BYTES || !file.name.isWellFormed(),
      "upload.invalid_name",
    ],
    [contentType === undefined, "upload.unsupported_type"],
  ].find(([failed]) => failed)?.[1];
  if (typeof code === "string") return { ok: false, code };
  return contentType === undefined
    ? { ok: false, code: "upload.unsupported_type" }
    : { ok: true, contentType };
}

const retryAfterOf = (value: string | null): number | null =>
  value !== null && /^\d{1,6}$/.test(value) ? Number(value) : null;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The error for a non-2xx reply; an off-contract body is `response.invalid`. */
export function failureOf(
  status: number,
  responseText: string,
  retryAfter: string | null,
): HttpError {
  const parsed = parseApiErrorBody(parseJson(responseText));
  return new HttpError(
    status,
    parsed?.code ?? "response.invalid",
    parsed?.requestId ?? null,
    retryAfterOf(retryAfter),
  );
}

/**
 * Streams one file to the same-origin upload route. XHR rather than fetch because only XHR reports
 * upload progress; the browser sets Content-Length from the Blob and adds Origin and the cookie.
 */
export function uploadDocument(
  workspaceId: string,
  file: File,
  contentType: string,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/workspaces/${encodeURIComponent(workspaceId)}/uploads`);
    xhr.setRequestHeader("content-type", contentType);
    xhr.setRequestHeader("x-filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(failureOf(xhr.status, xhr.responseText, xhr.getResponseHeader("retry-after")));
    xhr.onerror = () => reject(new HttpError(0, "network.unavailable"));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
