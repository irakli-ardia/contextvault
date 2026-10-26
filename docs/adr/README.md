# Architecture decision records

One short record per hard-to-reverse choice. A record is never edited to change its outcome; a later record supersedes it and both link each other.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-initial-stack.md) | Initial stack and repository shape | accepted |
| [0002](0002-postgres-pgvector.md) | PostgreSQL with pgvector, not a dedicated vector database | accepted |
| [0003](0003-nestjs-api.md) | NestJS for the API | accepted |
| [0004](0004-drizzle-orm.md) | Drizzle for schema and migrations | accepted |
| [0005](0005-provider-sdk-over-orchestration-framework.md) | Provider SDK behind ports, not an orchestration framework | accepted |
| [0006](0006-local-s3-seaweedfs.md) | SeaweedFS for local S3-compatible storage | accepted |
| [0007](0007-monorepo-and-toolchain.md) | Monorepo and toolchain | accepted |
| [0008](0008-first-party-authentication.md) | First-party authentication and sessions | accepted |

Index and vector-search tuning (exact scan versus HNSW) and reranker choice are decided in the milestones that need them.
