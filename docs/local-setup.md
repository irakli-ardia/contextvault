# Local setup

The repository holds the toolchain, the web, API, and worker skeletons, CI, and the local infrastructure
described below.

## Prerequisites

- Node.js `24.22.1` (pinned in `.node-version`)
- pnpm `12.15.0` (pinned in `package.json` as `packageManager`)
- Docker with Compose v2 (PostgreSQL with pgvector, Redis, S3-compatible storage)

With [nvm](https://github.com/nvm-sh/nvm), the versions can be installed without changing your default Node:

```bash
nvm install 24.22.1
nvm use 24.22.1
npm install -g pnpm@12.15.0
node -v   # v24.22.1
pnpm -v   # 12.15.0
```

`engineStrict` is on, so `pnpm install` fails on an unsupported Node version.

## Install and check

```bash
pnpm install --frozen-lockfile
pnpm run format:check   # Biome formatting
pnpm run lint           # Biome + type-aware oxlint
pnpm run arch           # fallow: import cycles and package boundaries
pnpm run dead-code      # fallow: unused files, exports, dependencies
pnpm run typecheck
pnpm run test               # unit, offline
pnpm run test:integration   # API over HTTP in-process, plus Redis (needs `pnpm run infra:up`)
pnpm run build
pnpm exec playwright install --with-deps --only-shell chromium   # once per machine
pnpm run test:e2e           # needs a prior build; serves it on 127.0.0.1:3100
node scripts/checks/docs-check.mjs
```

Real secrets live in `.env` (gitignored); `.env.example` lists every variable the project reads.

## Local infrastructure

```bash
cp .env.example .env       # once; the values are development-only placeholders
pnpm run infra:up          # start and wait until every service is healthy
pnpm run infra:ps          # status and ports
pnpm run infra:logs        # last 100 log lines
pnpm run infra:down        # stop, keep data
pnpm run infra:reset       # stop and DELETE all local data (the only destructive command)
pnpm run infra:smoke       # pgvector, Redis, S3 round trip, worker connect and shutdown (needs a worker build)
```

| Service | Image (pinned by digest) | Host port | Volume | Health check |
| --- | --- | --- | --- | --- |
| `postgres` | `pgvector/pgvector:0.8.7-pg18` | `127.0.0.1:5432` | `postgres-data` | `pg_isready` |
| `redis` | `redis:8.2-alpine` | `127.0.0.1:6379` | `redis-data` (AOF) | `redis-cli ping` |
| `s3` | `chrislusf/seaweedfs:4.51` (single process, S3 gateway) | `127.0.0.1:8333` | `s3-data` | master `/dir/assign` and S3 `/status` |

- Every port binds to loopback only. Credentials come from `.env`; Compose refuses to start when one is missing.
- `infra/postgres/init.sql` enables the `vector` extension on first initialisation of an empty volume. No schema or migrations exist yet.
- The S3 bucket (`S3_BUCKET`) is created by the smoke script; the application storage adapter will own that later.
- `infra:up` can take about 30 seconds on a restart with existing data: SeaweedFS waits for its topology to load before accepting writes.
- Ports 5432, 6379, and 8333 must be free; stop a local Postgres or Redis first.
- Updating an image: change the tag and digest together (`docker buildx imagetools inspect <image:tag>`), then run `infra:smoke`.

## Git hooks

Enable the git hooks once per clone:

```bash
node scripts/git/conventions.mjs install-hooks
```

The `pre-push` hook runs `pnpm run typecheck`, so push from a shell where `node -v` prints `v24.22.1`.
On another Node version, `engineStrict` makes the hook fail by design.
The hook also runs the integration tests, so start the infrastructure first (`pnpm run infra:up`).
