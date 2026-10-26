# ContextVault

An evidence-first retrieval workbench: ingest technical documents, compare keyword, vector, and hybrid retrieval and chunking strategies, and get answers whose citations resolve to source spans, or an explicit abstention when the evidence is insufficient.

**Status:** pre-implementation foundation. The repository holds the toolchain, CI, local infrastructure, validated environment configuration, first-party authentication (operator-created users, sessions, same-origin proxy), and web, API, and worker apps. No document features exist, and **no measured results are published yet**; nothing here is production-ready or security-reviewed for public deployment (see the [threat model](docs/threat-model.md)).

## Architecture

```text
browser ─► web (Next.js) ─► api (NestJS) ─► PostgreSQL + pgvector
                                         └► S3-compatible storage
                            worker (BullMQ) ─► Redis, PostgreSQL, S3
```

Today `web` serves one static page and proxies `/api/*` to the API, `api` serves `GET /health` and operator-created, session-authenticated workspace access ([ADR 0008](docs/adr/0008-first-party-authentication.md)), and `worker` connects to Redis and shuts down cleanly; the data stores run in Docker Compose. Request path, once features exist: UI → feature hook → client DAL → shared HTTP client → controller → application service → port → adapter. Decisions are recorded in the [ADRs](docs/adr/README.md).

## Stack

Next.js · NestJS · PostgreSQL + pgvector · Drizzle · BullMQ + Redis · S3-compatible storage (SeaweedFS locally) · TypeScript (strict) · Zod · Biome + oxlint + fallow · Vitest + Playwright · pnpm on Node.js 24 LTS

## Quickstart

Requires Node.js 24.22.1, pnpm 12.15.0 (see `.node-version` and `package.json`), and Docker with Compose v2.

```bash
pnpm install --frozen-lockfile
cp .env.example .env        # development-only placeholders
pnpm run infra:up           # postgres, redis, s3
pnpm run db:migrate         # schema, then `pnpm run user:create -- --email you@example.com`
pnpm run dev                # web :3000, api :3001, worker
```

Environment variables are listed in `.env.example` and described in [local setup](docs/local-setup.md#environment). Commands: `format:check`, `lint`, `arch`, `dead-code`, `typecheck`, `test`, `test:integration`, `build`, `test:e2e`, `infra:smoke`.

## Documentation

[Local setup](docs/local-setup.md) · [Threat model](docs/threat-model.md) · [ADRs](docs/adr/README.md) · [Security policy](SECURITY.md) · [License](LICENSE) (MIT)

Branch, commit, and PR-title conventions are enforced by `scripts/git/conventions.mjs` through the git hooks in `.githooks/` and CI.
