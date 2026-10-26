# 0009 — Streaming upload transport and raw-body contract

Status: accepted — 2026-10-26

## Context

[ADR 0008](0008-first-party-authentication.md) left one question open: Next.js buffers a rewritten request body and fails above 10 MB, so a 10 MiB document cannot go through the `/api/*` rewrite, and raising `proxyClientMaxBodySize` would hold every upload in web-server memory. The browser must still reach the API through the web origin (host-only cookie, no CORS). Measured on Next 16.4.3 (`next start`, loopback, 40 MiB body, upstream reading 64 KiB per 20 ms): a rewrite with a raised limit let the client finish in 37 ms (the whole body absorbed, no backpressure); a Route Handler paced the client to the upstream (12.2 s of 13.5 s).

## Decision

- **Transport:** a dedicated Route Handler, `POST /api/workspaces/{workspaceId}/uploads`, streams the request body to the API with backpressure. It decides nothing about identity: the API still authenticates, checks `Origin`, authorises, and counts the bytes it receives.
- **Rewrite order:** the `/api/*` rewrite moves to the `fallback` phase. The default `afterFiles` phase runs before dynamic routes and would shadow the handler with the buffering proxy.
- **Raw body, not multipart:** an S3 `PutObject` from a stream needs an exact length, and a multipart file part has none until it ends. The body is the file's bytes and nothing else, so `Content-Length` is the object size and the limit has no multipart overhead.

### Contract

| Item | Rule |
| --- | --- |
| Request | `POST /api/workspaces/{workspaceId}/uploads` (web origin). Other methods: 405. `workspaceId` must be a lowercase UUID, else 404 without contacting the API. The API path is built only from it: `POST {API_INTERNAL_URL}/workspaces/{workspaceId}/uploads`; query strings are dropped |
| `Content-Type` | `application/pdf`, `text/markdown`, or `text/plain` (case-insensitive; parameters ignored; the bare type is forwarded). Otherwise 415 `upload.unsupported_type` |
| `Content-Length` | Required, decimal digits only (no sign, space, hex, exponent, or leading zero), 1 to 10 485 760 (10 MiB). Missing or chunked: 411 `upload.length_required`. Malformed, or `Transfer-Encoding` together with `Content-Length`: 400 `upload.invalid_length`. Zero: 400 `upload.empty`. Over the limit: 413 `upload.too_large`, before any byte is sent upstream |
| `X-Filename` | Required. Percent-encoded UTF-8 (`encodeURIComponent`), printable ASCII only, at most 765 characters, decoding to 1 to 255 UTF-8 bytes with no control characters. Otherwise 400 `upload.invalid_name`. A header, not a query, so names stay out of URLs and access logs. Forwarded as received; the API decodes and sanitises it |
| Checks run in this order | framing, length, type, name |
| Body | Streamed through a byte counter that fails the request on any difference from the declared length (400 `upload.incomplete`). Never buffered |
| Cancellation | The client's abort signal aborts the upstream request |
| Forwarded to the API | `Cookie` and `Origin` unchanged (absent stays absent), canonical `Content-Type`, validated `Content-Length`, `X-Filename`, `Accept: application/json`. Nothing else: no `Host`, `X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `Authorization`, or request id |
| Relayed to the client | The API's status (200–299, 400–599) and JSON body, with `Content-Type`, `X-Request-Id`, `Retry-After`, plus `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Never `Set-Cookie`, `Location`, `Server`, or any other header |
| Upstream failures | A redirect, a non-JSON answer, or a status outside the range: 502 `upload.upstream_error`. An unreachable API or a broken connection: 502 `upload.upstream_unavailable`. Bodies carry a code and a request id only; logs carry codes only |
| Error body | `{ "error": { "code", "requestId" } }`, as the API |

Shape rules live in `packages/contracts` (`parseUploadHeaders`), shared by the handler and, from M1.3e, the API.

## Consequences

- Browsers send a `File` or `Blob` body with `Content-Length`. Chromium cannot send a chunked body over HTTP/1.1 (verified: `fetch` with a stream body rejects), so mandatory `Content-Length` holds for the browser client. Other clients get 411.
- The handler does not trust `Content-Length`; neither may the API. M1.3e must count received bytes, reject mismatches, and enforce the same limit.
- Nothing may match this path in a `proxy.ts` (middleware): Next would clone the body into memory and cap it at `proxyClientMaxBodySize`.
- **`API_INTERNAL_URL` has two readers** (verified on Next 16.4.3 with a build made under the default and a server started under another origin). The `/api/*` rewrite destination is evaluated by `next build` and stored in the build output; `next start` loads `next.config.ts` (so a malformed value still stops the server) but serves the stored destination, so changing the rewrite needs a rebuild. The upload handler reads the variable from the running server's environment, so a restart is enough for it, and it does not change the rewrite. If the build and the run environments differ, ordinary API calls and uploads reach different origins. Mitigation is operational: one source for the variable in both steps, rebuild and restart on every change, and a post-deploy check that a login and an upload reach the same API. The e2e web server on port 3101 sets a different runtime value on purpose, to point the handler at the test-only upstream.
- No client address reaches the API (as with the rewrite), so upload limits are per user. A per-address limit needs a trusted proxy ([ADR 0008](0008-first-party-authentication.md)).
- A refusal sent before the body is read (for example 401) arrives while the client is still writing; Chromium delivered the status for a 10 MiB body. The web server still reads and discards up to 10 MiB of such a body (bandwidth, not memory).
- Timeouts (idle, total) and concurrency limits belong to the API endpoint (M1.3e); socket timeouts in front of the web server are a deployment concern (M5).
- A reverse proxy that routes `/api/*` straight to the API is the better production shape; the handler then simply is not reached.
- Behaviour depends on Next internals (the raw request stream is handed to the handler). The browser and transport tests in `apps/web/e2e` are the guard on every Next upgrade.

## Alternatives considered

- Raising `proxyClientMaxBodySize` — buffers every upload in web memory with no backpressure, and applies to all proxied routes.
- Direct upload to the API with CORS — needs a second origin, credentialed CORS, and drops the host-only `__Host-` cookie.
- Multipart with `@aws-sdk/lib-storage` — 5 MiB part buffers per upload, abort cleanup, and a multipart parser to defend.
