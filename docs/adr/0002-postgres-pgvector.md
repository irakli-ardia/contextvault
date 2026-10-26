# 0002 — PostgreSQL with pgvector, not a dedicated vector database

Status: accepted — 2026-10-26

## Context

Retrieval combines keyword, vector, and hybrid search, and every query must apply workspace and document authorization. The corpus is a portfolio-scale document set, not a billion-vector workload.

## Decision

Store relational data, full-text indexes, and embeddings in one PostgreSQL database with the `pgvector` extension. Local development runs `pgvector/pgvector` pinned by digest; `infra/postgres/init.sql` enables the extension. Index types (exact scan versus HNSW) are decided in the retrieval milestone against measured data.

## Consequences

- Authorization predicates, metadata filters, and similarity ordering run in one SQL statement, so no result is fetched and filtered afterwards.
- One system to back up, migrate, and secure; transactions cover document and chunk state together.
- Vector search scale and recall tuning are bounded by Postgres and `pgvector`; revisit by ADR if measured latency or recall fails.
- Operators and index support must be verified against the deployed `pgvector` version.

## Alternatives considered

- Dedicated vector database — better at very large scale and specialised indexes, but a second store would split authorization across systems and add operations for no measured need.
