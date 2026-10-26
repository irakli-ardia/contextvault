# 0003 — NestJS for the API

Status: accepted — 2026-10-26

## Context

The API must separate transport from application logic, wire ports to adapters explicitly, and grow into several modules (identity, documents, retrieval) without a tangle of imports.

## Decision

Use NestJS as a modular monolith. Controllers handle transport only; application services own use cases; adapters implement ports behind an explicit composition root. The M0 API exposes `GET /health` only. It is bundled with `tsdown` ([0007](0007-monorepo-and-toolchain.md)).

## Consequences

- Dependency injection and module boundaries match the layered request path.
- Decorators and metadata need `experimentalDecorators` and `emitDecoratorMetadata`, which constrains the TypeScript configuration.
- More ceremony than a minimal framework; revisit by ADR if it outweighs the benefit.

## Alternatives considered

- A lighter HTTP framework — less ceremony, but module structure and injection would be hand-built and enforced by convention alone.
