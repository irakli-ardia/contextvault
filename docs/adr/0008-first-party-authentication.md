# 0008 — First-party authentication and sessions

Status: accepted — 2026-10-26

## Context

Uploads and every tenant read need a real identity before they exist. The stack is locked ([ADR 0001](0001-initial-stack.md)); this record covers how users sign in, how a request becomes a tenant context, and how the browser reaches the API.

## Decision

- **Accounts:** no registration endpoint. The operator creates users and resets passwords from a terminal (`pnpm run user:create`); the password is read from an interactive prompt only.
- **Passwords:** Argon2id from Node's built-in `crypto.argon2` (64 MiB, 3 passes, 1 lane, 16-byte salt, PHC string), at most two hashes in flight with a bounded queue, hash upgraded on login when parameters are stale. The API refuses to start unless an RFC 9106 known-answer test passes; the Node version is pinned to 24.22.1 because older runtimes lack the function.
- **Sessions:** opaque 256-bit random tokens in an `HttpOnly`, `SameSite=Lax`, host-only cookie (`__Host-cv_session` with `Secure` in production, `cv_session` in development). PostgreSQL stores only the SHA-256 of the token: 7 days absolute, 24 hours idle, revoked on logout, re-login, and password reset. A new token is issued on every login, so fixation is impossible.
- **Identity becomes tenant context only from the database:** a global default-deny session guard resolves the cookie to a session row; a workspace guard proves membership and answers 404 identically for a foreign, missing, or malformed workspace id. No header, body, or query value supplies a user or workspace. Row-level security applies the same rule again inside every transaction; login and session lookup use narrow, transaction-local "proofs" instead of a bypass role.
- **Same origin:** the browser talks only to the web origin. Next.js `rewrites` forward `/api/*` to one fixed backend origin (`API_INTERNAL_URL`, baked in at build time, a bare origin). There is no CORS and no `Access-Control-*` header.
- **CSRF:** every `POST`, `PUT`, `PATCH`, and `DELETE`, login included, must carry an `Origin` header exactly equal to `WEB_ORIGIN`. A missing, `null`, foreign, or look-alike origin gets 403. The check reads no `Host` or forwarded header. No CSRF token: one allowed origin, `SameSite=Lax`, and no state change on `GET` make the origin check sufficient.
- **Proxy trust:** the API binds to an explicit `API_HOST` (loopback in development) and sets Express `trust proxy` to `TRUSTED_PROXY_HOPS` (0 in development and test, mandatory in production). It never reads `req.protocol` or `req.hostname`, never redirects, and `Secure` follows `NODE_ENV`, not the request scheme.
- **Login throttling:** in-memory fixed-window counters per client address and per account, behind a `LoginLimiter` port. This is valid for **one API process only**.

## Consequences

- Behind the Next rewrite alone, the API cannot learn the client address: Next does not append `X-Forwarded-For`, so every request looks like it comes from the web server. A per-address limit is only meaningful when a trusted outer proxy appends the real address and `TRUSTED_PROXY_HOPS` equals the number of such proxies. Setting it to 1 on an API that is directly reachable lets any client choose its own address.
- The per-account limit does not depend on any header, so spoofed addresses cannot bypass it. A deliberate attacker can keep one named account throttled (delay capped at 15 minutes); it is not a hard lock.
- More than one API instance multiplies the allowance and a restart resets counters, so multi-instance deployment is unsupported until a Redis-backed limiter (same port) is added in its own increment.
- **Large uploads:** Next buffers a rewritten request body and fails above 10 MB, so a 10 MiB file cannot go through the rewrite. [ADR 0009](0009-streaming-upload-transport.md) is the accepted decision: a dedicated streaming Route Handler serves the upload path only, and the rewrite below it is unchanged in purpose. It keeps this record's invariants (host-only cookie, exact `Origin`, no CORS).
- Cookies are host-only to the web origin, so the web and API must be reached under one origin in any deployment. Moving the API to another origin would need a new decision (credentialed CORS, `SameSite` change).
- The session store and hasher are replaceable behind domain ports; switching to an identity provider later supersedes this record.

## Alternatives considered

- Better Auth, Auth.js, Clerk, Keycloak — more surface and a schema we would have to track for a single-tenant-style login; rejected for M1.
- Sessions in Redis — second source of truth, no RLS, repair logic; PostgreSQL gives revocation as a row.
- `@node-rs/argon2` or `crypto.scrypt` — a native dependency, or weaker per unit of memory; scrypt stays the documented fallback behind the same port.
- CSRF tokens — extra client state without added protection while there is one allowed origin.
- Credentialed CORS with a cross-origin API — cross-site cookies and an allowlist to maintain; the rewrite avoids both.
