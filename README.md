# ContextVault

An evidence-first retrieval workbench: ingest technical documents, compare keyword, vector, and hybrid retrieval and chunking strategies, and get answers whose citations resolve to source spans, or an explicit abstention when the evidence is insufficient.

**Status:** pre-implementation. The repository holds the toolchain, CI, and a configuration package skeleton; no application code exists yet, and no features or benchmark results are claimed.

**Requirements:** Node.js 24.22.1 and pnpm 12.15.0 (see `.node-version` and `package.json`).

## Planned stack

Next.js · NestJS · PostgreSQL + pgvector · Drizzle · BullMQ + Redis · S3-compatible storage · TypeScript (strict) · pnpm on Node.js 24 LTS · Vitest + Playwright

## Development

See [local setup](docs/local-setup.md). Branch, commit, and PR-title conventions are enforced by `scripts/git/conventions.mjs` through the git hooks in `.githooks/` and CI.
