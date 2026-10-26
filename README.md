# ContextVault

An evidence-first retrieval workbench: ingest technical documents, compare keyword, vector, and hybrid retrieval and chunking strategies, and get answers whose citations resolve to source spans, or an explicit abstention when the evidence is insufficient.

**Status:** pre-implementation. The repository currently holds tooling configuration only; no application code exists yet, and no features or benchmark results are claimed.

## Planned stack

Next.js · NestJS · PostgreSQL + pgvector · Drizzle · BullMQ + Redis · S3-compatible storage · TypeScript (strict) · pnpm on Node.js LTS · Vitest + Playwright

## Development

See [local setup](docs/local-setup.md). Branch, commit, and PR-title conventions are enforced by `scripts/git/conventions.mjs` through the git hooks in `.githooks/` and CI.
