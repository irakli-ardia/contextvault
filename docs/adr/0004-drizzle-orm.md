# 0004 — Drizzle for schema and migrations

Status: accepted — 2026-10-26

## Context

The schema includes vector columns and retrieval queries that must stay hand-controlled SQL. Migrations must be a deliberate, reviewable release step.

## Decision

Use Drizzle (`drizzle-orm` stable 0.x, not the 1.0 beta) for schema definition and migrations, with parameterized SQL for specialised search. It is adopted when the first schema is written; no database code exists in M0.

## Consequences

- Schema and types are defined in TypeScript and checked at compile time.
- Search queries can drop to parameterized SQL without fighting an abstraction.
- Drizzle is pre-1.0; pin it exactly and review upgrades.
- Vector similarity expressions are written as parameterized SQL, which the retrieval milestone must verify.

## Alternatives considered

- A full ORM with its own query language — heavier, and further from the SQL the retrieval path needs.
- A query builder without schema management — adds a separate migration tool.
