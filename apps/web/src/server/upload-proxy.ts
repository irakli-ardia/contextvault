import { parseUploadHeaders, type UploadHeaders } from "@contextvault/contracts";

// Streams one upload to the API. It decides nothing about identity: the API authenticates, checks
// the Origin, authorises, and counts bytes again. This layer only keeps the body from being
// buffered and from reaching anywhere but one fixed, validated URL.
//
// Next buffers a body whenever it is cloned (middleware/`proxy.ts`, or an external rewrite that
// has no backpressure). A Route Handler is handed the raw request stream instead, so nothing may
// ever match this path in a `proxy.ts` (ADR 0009).

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface UploadProxyDeps {
  /** Bare origin of the API (`API_INTERNAL_URL`); the only host this module can reach. */
  readonly upstreamOrigin: string;
  readonly fetch: typeof fetch;
  readonly newRequestId?: () => string;
}

const SAFE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function refusal(status: number, code: string, requestId: string) {
  return Response.json(
    { error: { code, requestId } },
    { status, headers: { ...SAFE_HEADERS, "x-request-id": requestId } },
  );
}

class LengthMismatch extends Error {}

// fetch wraps a failing request body as the `cause` of its own TypeError.
const isMismatch = (error: unknown): boolean =>
  error instanceof LengthMismatch ||
  (error instanceof Error && error.cause instanceof LengthMismatch);

// Counts what actually flows and fails the stream on any difference from the declared length.
// Default queuing strategy: one chunk of slack, so backpressure reaches the client socket.
function exactLength(expected: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > expected) throw new LengthMismatch();
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== expected) throw new LengthMismatch();
    },
  });
}

function upstreamHeaders(request: Request, parsed: UploadHeaders): Headers {
  // Explicit allowlist. Host and every forwarding header are deliberately absent: the API must
  // never learn client-chosen values for them (ADR 0008).
  const headers = new Headers({
    accept: "application/json",
    "content-type": parsed.contentType,
    "content-length": String(parsed.contentLength),
    "x-filename": parsed.encodedFilename,
  });
  const cookie = request.headers.get("cookie");
  if (cookie !== null) headers.set("cookie", cookie);
  const origin = request.headers.get("origin");
  if (origin !== null) headers.set("origin", origin);
  return headers;
}

function relay(upstream: Response, requestId: string): Response {
  const type = upstream.headers.get("content-type") ?? "";
  // The API never redirects and always answers JSON; anything else is not ours to pass on.
  if (
    upstream.status < 200 ||
    upstream.status > 599 ||
    (upstream.status >= 300 && upstream.status < 400)
  ) {
    return refusal(502, "upload.upstream_error", requestId);
  }
  if (upstream.body !== null && !type.toLowerCase().startsWith("application/json")) {
    return refusal(502, "upload.upstream_error", requestId);
  }
  const headers = new Headers(SAFE_HEADERS);
  for (const name of ["content-type", "x-request-id", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function proxyUpload(
  request: Request,
  workspaceId: string,
  deps: UploadProxyDeps,
): Promise<Response> {
  const requestId = (deps.newRequestId ?? (() => crypto.randomUUID()))();
  // Same answer as the API gives a non-member: nothing here reveals which ids exist.
  if (!WORKSPACE_ID.test(workspaceId)) return refusal(404, "not_found", requestId);
  const checked = parseUploadHeaders(request.headers);
  if (!checked.ok) return refusal(checked.refusal.status, checked.refusal.code, requestId);
  const parsed = checked.value;
  if (request.body === null) return refusal(400, "upload.empty", requestId);

  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: upstreamHeaders(request, parsed),
    body: request.body.pipeThrough(exactLength(parsed.contentLength)),
    duplex: "half",
    redirect: "manual",
    cache: "no-store",
    // Client cancellation aborts the upstream request, which lets the API clean up.
    signal: request.signal,
  };
  try {
    const url = new URL(`/workspaces/${workspaceId}/uploads`, deps.upstreamOrigin);
    return relay(await deps.fetch(url, init), requestId);
  } catch (error) {
    // Codes only: error text can carry the internal address or request data.
    const code = isMismatch(error) ? "upload.incomplete" : "upload.upstream_unavailable";
    console.error(JSON.stringify({ code, requestId }));
    return refusal(code === "upload.incomplete" ? 400 : 502, code, requestId);
  }
}
