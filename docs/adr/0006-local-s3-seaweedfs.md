# 0006 — SeaweedFS for local S3-compatible storage

Status: accepted — 2026-10-26

## Context

Development and tests need a private S3-compatible store in Docker Compose. MinIO's repository was archived in 2026, so it is no longer a safe default.

## Decision

Run `chrislusf/seaweedfs` as a single container in S3 mode, pinned by digest, bound to loopback, with credentials from `.env`. `scripts/checks/infra-smoke.mjs` verifies a signed PUT, GET, range read, and delete, and that anonymous and wrong-secret requests are refused. Production storage is whatever S3-compatible provider is configured; the application depends only on the S3 protocol behind a port.

## Consequences

- Mature, actively maintained, Apache-2.0; one container.
- M1.3b verified the adapter against it (streamed `PutObject` with an exact `Content-Length`, `HeadObject`, idempotent `DeleteObject`, aborted puts leave nothing, path-style addressing). Presigned URLs and multipart upload are not used: the plan forbids the first and the raw-body contract ([ADR 0009](0009-streaming-upload-transport.md)) removes the need for the second. Differences found: a missing bucket is created by the first authenticated `PutObject` unless the server runs with `-s3.autoCreateBucket=false`, which Compose now sets; `DeleteObject` of a missing key answers 204; conditional `If-None-Match: *` writes are atomic (412 on conflict, exactly one concurrent winner); `HeadBucket` answers 404 for a missing bucket; the SDK's default checksum trailer is unusable for streams (see the M1.3 plan).
- Larger feature surface than a single-purpose store, and behavior differs from AWS S3 in details; presigned URLs and multipart upload are not used (see below).
- If the smoke test cannot be kept passing, RustFS is the fallback (never both) and this record is superseded.

## Alternatives considered

- RustFS — S3-compatible and lightweight, but its first stable line is recent and behavior changed between early releases.
- MinIO — archived upstream.
