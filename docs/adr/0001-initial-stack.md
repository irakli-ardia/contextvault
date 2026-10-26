# 0001 — Initial stack and repository shape

Status: accepted — 2026-10-26

## Context

A single-owner system that must be deployable, demonstrable, and rigorously tested. It needs relational data with vector and full-text search, durable asynchronous ingestion, private file storage, and a public read-only demo with bounded model spend.

## Decision

Next.js App Router · NestJS · PostgreSQL + pgvector · Drizzle · BullMQ + Redis · S3-compatible storage · OpenAI adapter · Zod · Biome + oxlint · fallow · Vitest + Playwright · pnpm on Node LTS.

A pnpm monorepo with three apps (`web`, `api`, `worker`) and shared packages. Request path: UI → feature hook → client DAL → shared HTTP client → NestJS controller → application service → port → adapter/repository.

## Consequences

- One database holds relational, full-text, and vector data, so authorization filters apply in a single query.
- Typed contracts end to end; strict TypeScript.
- Ports isolate OpenAI and storage, so tests stay deterministic and free.
- NestJS and BullMQ add ceremony; revisit by ADR if disproportionate.
- Authorization lives in retrieval SQL, the core stays deterministic, and vendors sit behind ports.

## Alternatives considered

- Dedicated vector database — see [0002](0002-postgres-pgvector.md).
- Lighter API than NestJS, other ORMs, orchestration frameworks — see [0003](0003-nestjs-api.md), [0004](0004-drizzle-orm.md), [0005](0005-provider-sdk-over-orchestration-framework.md).
