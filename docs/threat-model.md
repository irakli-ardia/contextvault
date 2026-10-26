# Threat model

Baseline through M1.3a (authentication and the upload transport). It separates what exists in the repository today from what later milestones must build. A control is listed as **implemented** only if code, configuration, or a test in this repository enforces it. Everything else is **not built** and is not a claim.

Milestones: M1 secure document slice (identity, upload, parsing, worker, schema) · M2 retrieval and chunking lab · M3 grounded answers (AI) · M4 evaluation · M5 production hardening and release.

## Assets

| Asset | Where it will live | Exists today |
| --- | --- | --- |
| Uploaded documents and extracted text | S3-compatible storage, PostgreSQL | No (no upload path, no schema) |
| Embeddings and retrieval indexes | PostgreSQL + pgvector | No |
| Workspace membership, password hashes, and sessions | PostgreSQL | Yes (accounts are operator-created) |
| Provider API keys, database, Redis, and S3 credentials | Environment or a secret manager | Local placeholders only |
| Job state | PostgreSQL (truth), Redis (queue) | No queues |
| Source code, CI, and the dependency tree | GitHub, npm registry | Yes |

## Trust boundaries

```text
browser ──► web (Next.js) ──rewrite /api/*──► api (NestJS) ──► PostgreSQL / S3 ◄── worker ──► Redis
untrusted     one origin         auth, workspaces    app role, RLS       Redis only
```

1. **Internet to web and api.** Everything a client sends is untrusted. The API serves `GET /health` (public, constant body) and the authentication and workspace routes; every other route requires a session. The browser reaches the API only through the web origin; the API must not be reachable by clients directly in production (see the proxy assumptions below).
2. **api and worker to infrastructure.** Postgres, Redis, and S3 are trusted backends that must not be reachable by clients. Today only the worker opens a connection (Redis, with a password).
3. **Documents to every parser, indexer, and model.** Document bytes and text are untrusted data, never instructions. No code reads documents yet.
4. **Environment and configuration.** Treated as trusted but validated at startup, so a misconfigured deployment stops instead of running degraded.
5. **Contributors, CI, and dependencies.** Pull requests, third-party packages, container images, and GitHub Actions are outside the trust boundary until pinned and verified.

## Implemented today

| Area | Control | Enforced by |
| --- | --- | --- |
| Configuration | Required variables are validated with Zod; a missing or malformed one stops the process, naming the variable, never its value | `packages/config` unit tests; api and worker bootstrap |
| Configuration | Only `packages/config` reads `process.env` | Review convention; not mechanically enforced |
| Secrets | `.env` is gitignored; `.env.example` holds development-only placeholders; tracked key material, environment files, and local-only files fail the build | `.gitignore`, `scripts/checks/tracked-files.mjs` (CI and `pre-push`) |
| Logging | Process guards, the worker, and Redis error handling log fixed codes, not error text, which may carry secrets or document content | `apps/*/src/process-guards.ts`, `apps/worker/src/main.ts` |
| Information disclosure | `X-Powered-By` is disabled on the API and web | `apps/api/src/main.ts`, `apps/web/next.config.ts` |
| Local infrastructure | Ports bind to loopback; Compose refuses to start without credentials; Redis requires a password; images are pinned by digest; unauthenticated and wrong-secret S3 reads, writes, and deletes are refused and leave nothing behind | `infra/compose.yaml`, `scripts/checks/infra-smoke.mjs` |
| Supply chain | Frozen lockfile; exact dependency versions; packages younger than one day are refused (`minimumReleaseAge`); install scripts are blocked unless allowlisted (`allowBuilds`); strict Node and pnpm versions | `pnpm-workspace.yaml`, `package.json`, `.node-version` |
| CI | Read-only token (`contents: read`); credentials not persisted by checkout; actions pinned to commit SHAs; untrusted PR fields (branch, title) passed through environment variables, not interpolated into scripts; merge gate blocks the `do-not-merge` label | `.github/workflows/` |
| Tenant isolation (schema only) | PostgreSQL row-level security on `workspaces` and `memberships`, forced, fail-closed: no user context returns no rows. Access is proven by a membership row for the asserted user, so naming a workspace id grants nothing. The application role owns no table, is not a superuser, has no `BYPASSRLS`, no DDL, and only `SELECT`/`INSERT`. Context is transaction-local, so pooled connections never carry it over. `users` has RLS enabled but not forced, deliberately: the schema owner must be able to create accounts, and the application role (not the owner) is limited to its own row. The workspace-creation window is bound to a server-set `created_at`. Lint keeps the owner-role migration URL out of `apps/*` | `infra/migrations`, `infra/postgres/init-roles.sh`, `packages/db` integration tests against real PostgreSQL |
| Passwords | Argon2id (`crypto.argon2`, 64 MiB, 3 passes), constant-cost login for unknown and known emails, at most two hashes in flight, RFC 9106 self-test at boot; accounts and resets only by the operator CLI with an interactive prompt | `packages/auth`, `packages/db/src/provisioning` unit and integration tests |
| Sessions | Opaque 256-bit tokens, only the SHA-256 stored; `HttpOnly`, `SameSite=Lax`, host-only cookie (`__Host-` and `Secure` in production); 7-day absolute and 24-hour idle limits; revoked on logout, re-login, and password reset; fresh token per login (no fixation) | API integration tests; browser tests through the web origin (`apps/web/e2e`) |
| Authorization | Global default-deny session guard; workspace id never taken from the client; non-member, missing, and malformed workspace ids return the same 404; authentication proofs and tenant tables are row-level-secured and fail closed; the API refuses to start as a superuser, a `BYPASSRLS` role, or a table owner | `apps/api` guards and integration tests, `packages/db` RLS probes, browser tests |
| CSRF and CORS | Every unsafe method (login included) needs `Origin` equal to `WEB_ORIGIN`; missing, `null`, foreign, and look-alike origins get 403 through the real proxy; no `Access-Control-*` header is ever sent | API tests; `apps/web/e2e/proxy.spec.ts` |
| Proxy | One fixed rewrite destination (bare origin, not an open proxy); `Set-Cookie` attributes survive it; spoofed `X-Forwarded-*` change neither the origin check nor cookie flags; the API never redirects and no response carries the internal API address; explicit `API_HOST` bind; `TRUSTED_PROXY_HOPS` mandatory in production | `apps/web/next.config.ts`, `packages/config`, browser tests |
| Upload transport | Streaming Route Handler with backpressure; mandatory exact `Content-Length` (1 B to 10 MiB, plain decimal), refused before any upstream byte when over; byte counter on the stream; fixed destination built from a validated workspace UUID; explicit header allowlist (no `Host`, `X-Forwarded-*`, `Authorization`); client abort propagates; redirects, non-JSON, and unreachable upstreams become generic 502s with no internal address, `Set-Cookie`, or `Location` | `apps/web/src/server/upload-proxy.ts`, `packages/contracts`, unit tests, browser tests (`apps/web/e2e/upload-*.spec.ts`) against a test-only upstream, Nest probe test |
| Login throttling | Per-account (header-independent) and per-address in-memory limits with identical 429/401 bodies | `apps/api` tests. **Single API process only** |
| Responses and logs | `Cache-Control: no-store`, `nosniff`; error responses carry a stable code and request id; no password, token, or hash in responses or API and web logs | API leak tests; browser log check |
| Updates | Dependabot proposes npm (weekly) and Actions (monthly) updates | `.github/dependabot.yml` |
| Fail fast | Unhandled rejections and uncaught exceptions terminate api and worker | `apps/*/src/process-guards.ts` |

## Threats and status

| Threat | Today | Planned | Required before public deployment |
| --- | --- | --- | --- |
| Cross-tenant data exfiltration, IDOR, document enumeration | Database layer and session identity built and tested; no tenant data beyond workspaces yet. The user id comes only from a verified session row. A compromised API process can still assert any user or authentication proof (RLS stops forgotten filters and injected queries, not code execution in the API) | M1 workspace identity and guards; M2 authorization inside retrieval SQL | Cross-tenant integration tests for every read path, including workers and evaluation artifacts |
| Compromised upload (malicious file, zip or PDF bomb) | Not built: no upload | M1 private storage, type and size limits, parser timeouts | Content-type verification, quotas, parsing sandbox or resource limits, private bucket |
| Oversized files and resource exhaustion | Login hashing is bounded (two in flight, queue of eight, then 429); the upload transport refuses declared sizes over 10 MiB and streams with backpressure (web layer only; no API endpoint yet) | M1 limits and bounded queue concurrency | The API must count received bytes and enforce the limit again, plus per-user (and, behind a trusted proxy, per-IP) rate limits |
| Replayed or stale jobs | Not built: the worker has no processors | M1 idempotent, version-fenced jobs; the database is the source of truth | Crash-recovery and stale-worker tests |
| Prompt injection from documents | Not built: no model calls | M3 untrusted-data separation, no unrestricted tools, adversarial corpus | An adversarial test corpus. No claim of perfect prevention |
| Unsafe AI tool execution | Not built: no tools | M3 deny by default; any tool needs its own review | No model-driven tool may reach storage, the network, or other tenants |
| Denial of wallet (provider spend) | Not built: no provider calls, and none are permitted without a spend ceiling | M3 rate and cost controls | Hard spend ceiling, per-user quotas, and demo abuse controls |
| SSRF | Not applicable: no URL fetching | Remote URLs stay out of scope | Egress allowlist and private-range blocking before any fetch feature |
| Unsafe rendering (XSS from document text or answers) | Not built: web renders one static page | M3 answer UI | Sanitized rendering and a Content Security Policy |
| Secrets and log leakage | Partly: see the table above | Ongoing | Structured logging that never records document bodies, prompts, or credentials; secret scanning enabled on the repository |
| Supply chain | Partly: see the table above | M5 | Dependency vulnerability scanning in CI; image and Action updates reviewed |
| Credential stuffing and brute force | Per-account and per-address throttling, single process; no registration endpoint (accounts are operator-created) | Redis-backed limiter for more than one instance | Distributed limiter, alerting, and a trusted proxy that supplies the real client address |
| Session theft or fixation | `HttpOnly` cookie, hashed tokens, new token per login, server-side revocation; no JavaScript access | M5 CSP and HSTS | HTTPS only, HSTS, and a Content Security Policy |
| Cross-site request forgery | Exact `Origin` match on unsafe methods plus `SameSite=Lax` | Revisit if a second origin or a non-browser client appears | Production `WEB_ORIGIN` over HTTPS |
| Other browser-facing hardening | Not built: CSP, HSTS, framing policy | M5 | Security headers beyond `nosniff` and `no-store` |
| Retention and deletion | Not built | M1 delete path | Documented retention and export or deletion policy; audit logs for sensitive mutations |

## Known gaps in the current code

- **Proxy topology assumptions (production, not yet deployed).** The browser must reach the API only through the web origin, and the API must accept connections only from the web server (private network or loopback). `TRUSTED_PROXY_HOPS` must equal the number of trusted proxies that append the real client address in front of the API: Next's rewrite appends none, so with the rewrite alone every client appears as the web server and the per-address login limit is effectively global. A value of 1 on an API that clients can reach directly lets them choose their own address. Neither condition is enforced by code, only documented, and a real deployment is unverified.
- **Residual risks of authentication.**
  - The login limiter is in memory: single instance only, reset by a restart, bypassed by running several instances. Redis is the multi-instance path and is not built.
  - A compromised API process can present any authentication proof or user id; row-level security does not defend against code execution in the API.
  - A deliberate attacker can keep a named account throttled (bounded by a 15-minute delay).
  - `crypto.argon2` exists only on Node 24.7 and later (the pinned runtime is 24.22.1); the API refuses to start if the self-test fails, and no other runtime is verified.
  - Session cleanup is per user on login; there is no global sweep of expired rows yet.
  - No CSP, HSTS, or framing policy; no audit log of sign-ins; there is no self-service password reset (the operator resets).
  - The browser tests cover the development cookie (`cv_session`, no `Secure`); the production variant (`__Host-`, `Secure`, HTTPS origin) is covered by API tests only, not through a real HTTPS proxy.
- **Upload transport (M1.3a).** The streaming handler bounds what the web process accepts (declared length 1 byte to 10 MiB, counted again while streaming) and forwards a fixed header set to a fixed origin. It does not authenticate: until the API endpoint exists (M1.3e) there is nothing to authorise, and afterwards the API must count bytes and enforce limits itself. The web server still reads and discards up to 10 MiB of a body the API refuses early (bandwidth, not memory); idle and total timeouts are API work (M1.3e) and socket timeouts in front of the web server are a deployment concern. Nothing may match the upload path in `proxy.ts` ([ADR 0009](adr/0009-streaming-upload-transport.md)).
- **No dependency vulnerability scan or secret scan runs in CI.** Dependabot version updates are not a vulnerability scan.
- **`multer` advisory GHSA-q7qp-rjg7-q26m (high, resolved 2026-10-26):** `@nestjs/platform-express` 12.2.0 pins `multer` 2.4.0, which has a denial of service in a pending asynchronous `fileFilter`. A scoped override (`multer@<2.5.0: 2.5.0` in `pnpm-workspace.yaml`) installs 2.5.0; `pnpm audit` is clean. The override is temporary and is removed once Nest ships a fixed pin. The API registers no upload handler yet.
- **Local credentials are placeholders.** The values in `.env.example` are public. Never reuse them outside the local Compose stack.
- **Git history is public once pushed.** Commit author metadata and any past content cannot be retracted by later commits.

## Reporting

Report vulnerabilities privately; see [SECURITY.md](../SECURITY.md).
