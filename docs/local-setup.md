# Local setup

The repository holds the toolchain, the web, API, and worker skeletons, validated environment configuration,
CI, and the local infrastructure described below.

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

## Clean clone, from zero

Run from the repository root, in this order. Docker must be running.

```bash
git clone <repository-url> contextvault && cd contextvault
node -v && pnpm -v                          # v24.22.1 and 12.15.0
pnpm install --frozen-lockfile
cp .env.example .env                        # development-only placeholders; never commit .env
pnpm run infra:up                           # postgres, redis, s3; waits until healthy
pnpm run dev                                # web, api, and worker, in parallel
```

Startup order: infrastructure first, then the apps. The worker connects to Redis at boot and exits if it
is unreachable; the API starts without any service because it opens no connection yet.

| App | Start alone | Address | Check |
| --- | --- | --- | --- |
| web | `pnpm --filter @contextvault/web dev` | `http://127.0.0.1:3000` | open in a browser |
| api | `pnpm --filter @contextvault/api dev` | `http://127.0.0.1:3001` (`API_PORT`) | `curl http://127.0.0.1:3001/health` returns `{"status":"ok"}` |
| worker | `pnpm --filter @contextvault/worker dev` | none | logs `worker ready`; `Ctrl-C` shuts it down cleanly |

## Environment

`api` and `worker` read their variables through `packages/config`, the only module that touches `process.env`.
`.env.example` is the committed contract; `.env` (gitignored) is loaded by the dev scripts and by `test:integration`.

| Variable | Read by | Rule |
| --- | --- | --- |
| `NODE_ENV` | api, worker | `development`, `test`, or `production` |
| `API_PORT` | api | integer 1-65535 |
| `REDIS_URL` | worker | `redis://` or `rediss://` URL |
| `DATABASE_URL` | none yet | `postgres://` or `postgresql://` URL |
| `S3_ENDPOINT` | none yet | `http://` or `https://` URL |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | none yet | non-empty |
| `S3_REGION` | none yet | optional, defaults to `us-east-1` |

`DATABASE_URL` and `S3_*` have validated, tested parsers in `packages/config` (`loadDatabaseEnv`, `loadS3Env`)
for the M1 adapters, but no app requires them yet, so the API starts without Postgres or S3 settings and the
worker without anything but Redis. `POSTGRES_*` and `REDIS_PASSWORD` are read by Docker Compose only. A
missing or malformed variable stops the process with a list of variable names and rules, never values:

```text
Invalid environment variables:
- NODE_ENV: Invalid option: expected one of "development"|"test"|"production"
- API_PORT: Invalid input: expected number, received NaN
```

If `.env` is absent, the dev scripts still start, and the apps fail with that list.

## Checks and tests

```bash
pnpm run format:check   # Biome formatting
pnpm run lint           # Biome + type-aware oxlint
pnpm run arch           # fallow: import cycles and package boundaries
pnpm run dead-code      # fallow: unused files, exports, dependencies
pnpm run typecheck
pnpm run test               # unit, offline
pnpm run test:integration   # API over HTTP in-process, plus Redis (needs `pnpm run infra:up` and `.env`)
pnpm run build
pnpm run infra:smoke        # needs `infra:up` and a worker build
pnpm exec playwright install --with-deps --only-shell chromium   # once per machine
pnpm run test:e2e           # needs a prior web build; serves it on 127.0.0.1:3100
node scripts/checks/docs-check.mjs
node scripts/checks/tracked-files.mjs   # no local-only or sensitive file is tracked or referenced
```

## Local infrastructure

```bash
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

## Troubleshooting

- `Invalid environment variables`: compare `.env` with `.env.example`; the message names each bad variable.
- `pnpm install` rejects the Node version: run `node -v`; it must print `v24.22.1`.
- `infra:up` times out or a port is taken: stop a local Postgres or Redis, then see `pnpm run infra:logs`.
- Worker exits at boot: Redis is unreachable or `REDIS_URL` has the wrong password; run `pnpm run infra:ps`.
