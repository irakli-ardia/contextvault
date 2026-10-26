# 0006 — SeaweedFS for local S3-compatible storage

Status: accepted — 2026-10-26

## Context

Development and tests need a private S3-compatible store in Docker Compose. MinIO's repository was archived in 2026, so it is no longer a safe default.

## Decision

Run `chrislusf/seaweedfs` as a single container in S3 mode, pinned by digest, bound to loopback, with credentials from `.env`. `scripts/checks/infra-smoke.mjs` verifies a signed PUT, GET, range read, and delete, and that anonymous and wrong-secret requests are refused. Production storage is whatever S3-compatible provider is configured; the application depends only on the S3 protocol behind a port.

## Consequences

- Mature, actively maintained, Apache-2.0; one container.
- Larger feature surface than a single-purpose store, and behavior differs from AWS S3 in details; presigned URLs and multipart upload are verified when the storage adapter is built.
- If the smoke test cannot be kept passing, RustFS is the fallback (never both) and this record is superseded.

## Alternatives considered

- RustFS — S3-compatible and lightweight, but its first stable line is recent and behavior changed between early releases.
- MinIO — archived upstream.
