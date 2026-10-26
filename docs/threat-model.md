# Threat model

Baseline for the M0 foundation. It separates what exists in the repository today from what later milestones must build. A control is listed as **implemented** only if code, configuration, or a test in this repository enforces it. Everything else is **not built** and is not a claim.

Milestones: M1 secure document slice (identity, upload, parsing, worker, schema) · M2 retrieval and chunking lab · M3 grounded answers (AI) · M4 evaluation · M5 production hardening and release.

## Assets

| Asset | Where it will live | Exists today |
| --- | --- | --- |
| Uploaded documents and extracted text | S3-compatible storage, PostgreSQL | No (no upload path, no schema) |
| Embeddings and retrieval indexes | PostgreSQL + pgvector | No |
| Workspace membership and sessions | PostgreSQL | No |
| Provider API keys, database, Redis, and S3 credentials | Environment or a secret manager | Local placeholders only |
| Job state | PostgreSQL (truth), Redis (queue) | No queues |
| Source code, CI, and the dependency tree | GitHub, npm registry | Yes |

## Trust boundaries

```text
browser ──► web (Next.js) ──► api (NestJS) ──► PostgreSQL / S3 ◄── worker ──► Redis
untrusted     static page      GET /health      no client yet      Redis only
```

1. **Internet to web and api.** Everything a client sends is untrusted. Today the API serves one unauthenticated route, `GET /health`, which returns a constant body and reads no input.
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
| Updates | Dependabot proposes npm (weekly) and Actions (monthly) updates | `.github/dependabot.yml` |
| Fail fast | Unhandled rejections and uncaught exceptions terminate api and worker | `apps/*/src/process-guards.ts` |

## Threats and status

| Threat | Today | Planned | Required before public deployment |
| --- | --- | --- | --- |
| Cross-tenant data exfiltration, IDOR, document enumeration | Not built: no identity, no data | M1 workspace identity and guards; M2 authorization inside retrieval SQL | Cross-tenant integration tests for every read path, including workers and evaluation artifacts |
| Compromised upload (malicious file, zip or PDF bomb) | Not built: no upload | M1 private storage, type and size limits, parser timeouts | Content-type verification, quotas, parsing sandbox or resource limits, private bucket |
| Oversized files and resource exhaustion | Not built | M1 limits and bounded queue concurrency | Request body limits and per-user and per-IP rate limits |
| Replayed or stale jobs | Not built: the worker has no processors | M1 idempotent, version-fenced jobs; the database is the source of truth | Crash-recovery and stale-worker tests |
| Prompt injection from documents | Not built: no model calls | M3 untrusted-data separation, no unrestricted tools, adversarial corpus | An adversarial test corpus. No claim of perfect prevention |
| Unsafe AI tool execution | Not built: no tools | M3 deny by default; any tool needs its own review | No model-driven tool may reach storage, the network, or other tenants |
| Denial of wallet (provider spend) | Not built: no provider calls, and none are permitted without a spend ceiling | M3 rate and cost controls | Hard spend ceiling, per-user quotas, and demo abuse controls |
| SSRF | Not applicable: no URL fetching | Remote URLs stay out of scope | Egress allowlist and private-range blocking before any fetch feature |
| Unsafe rendering (XSS from document text or answers) | Not built: web renders one static page | M3 answer UI | Sanitized rendering and a Content Security Policy |
| Secrets and log leakage | Partly: see the table above | Ongoing | Structured logging that never records document bodies, prompts, or credentials; secret scanning enabled on the repository |
| Supply chain | Partly: see the table above | M5 | Dependency vulnerability scanning in CI; image and Action updates reviewed |
| Browser-facing hardening | Not built | M5 | Security headers, a CORS policy, secure cookies, and CSRF protection for cookie-authenticated mutations |
| Retention and deletion | Not built | M1 delete path | Documented retention and export or deletion policy; audit logs for sensitive mutations |

## Known gaps in the current code

- **The API listens on all interfaces.** `app.listen(port)` is not restricted to loopback. In development, `GET /health` is reachable from the local network. It exposes nothing, but the bind address must be an explicit deployment setting before the API serves anything else.
- **No authentication, CORS policy, security headers, rate limiting, or request-size policy.** Nothing yet needs them; each is required before public deployment.
- **No dependency vulnerability scan or secret scan runs in CI.** Dependabot version updates are not a vulnerability scan.
- **`multer` advisory GHSA-q7qp-rjg7-q26m (high, resolved 2026-10-26):** `@nestjs/platform-express` 12.2.0 pins `multer` 2.4.0, which has a denial of service in a pending asynchronous `fileFilter`. A scoped override (`multer@<2.5.0: 2.5.0` in `pnpm-workspace.yaml`) installs 2.5.0; `pnpm audit` is clean. The override is temporary and is removed once Nest ships a fixed pin. The API registers no upload handler yet.
- **Local credentials are placeholders.** The values in `.env.example` are public. Never reuse them outside the local Compose stack.
- **Git history is public once pushed.** Commit author metadata and any past content cannot be retracted by later commits.

## Reporting

Report vulnerabilities privately; see [SECURITY.md](../SECURITY.md).
