# 0005 — Provider SDK behind ports, not an orchestration framework

Status: accepted — 2026-10-26

## Context

Parsing, validation, access control, deduplication, fusion, citation resolution, and accounting must be deterministic. Model calls are limited to embeddings and answer generation, and tests must never reach a provider.

## Decision

Call the model provider's SDK only from an adapter behind a port. Do not adopt an orchestration framework (chains, agents, retrievers). Prompt assembly, context budgeting, and citation resolution are plain, tested code.

## Consequences

- Fixtures and fakes replace the provider in every test; no live call happens without explicit approval and a spend ceiling.
- No framework-defined control flow: the code sees exactly what is sent and every spend is accounted.
- Retries, streaming, and cancellation are written and tested here rather than inherited.
- Swapping providers means writing one adapter.

## Alternatives considered

- An orchestration framework — faster demos, but hidden prompts and control flow work against deterministic, auditable behavior and add a fast-moving dependency.
