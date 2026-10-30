# Local setup

The repository holds the toolchain, the web, API, and worker apps, first-party authentication (operator-created
users, sessions, same-origin proxy), validated environment configuration, CI, and the local infrastructure described below.

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

`engineStrict` is on, so `pnpm install` fails on an unsupported Node version. **The exact runtime matters for security:** password hashing uses `crypto.argon2`, which exists only on Node 24.7 and later, and the API refuses to start if its self-test fails. Node 24.22.1 is the only runtime verified; do not run the API on an older or different major.

## Clean clone, from zero

Run from the repository root, in this order. Docker must be running.

```bash
git clone <repository-url> contextvault && cd contextvault
node -v && pnpm -v                          # v24.22.1 and 12.15.0
pnpm install --frozen-lockfile
cp .env.example .env                        # development-only placeholders; never commit .env
pnpm run infra:up                           # postgres, redis, s3; waits until healthy
pnpm run db:migrate                         # create or update the schema (a deliberate step)
pnpm run user:create -- --email you@example.com   # your login; prompts for a password (see User accounts)
pnpm run dev                                # web, api, and worker, in parallel
```

Startup order: infrastructure first, then the apps. The worker connects to Redis at boot and exits if it
is unreachable; the API connects to PostgreSQL at boot and exits if the role is not least-privileged.

| App | Start alone | Address | Check |
| --- | --- | --- | --- |
| web | `pnpm --filter @contextvault/web dev` | `http://127.0.0.1:3000` | open in a browser |
| api | `pnpm --filter @contextvault/api dev` | `http://127.0.0.1:3001` (`API_HOST`, `API_PORT`) | `curl http://127.0.0.1:3001/health` returns `{"status":"ok"}` |
| worker | `pnpm --filter @contextvault/worker dev` | none | logs `worker ready`; `Ctrl-C` shuts it down cleanly |

## Environment

`api` and `worker` read their variables through `packages/config`, the only module that touches `process.env`.
`.env.example` is the committed contract. `.env` (gitignored) is read by `scripts/run-with-env.mjs` for api and worker, and separately by administrative and test tooling (`infra:*`, `db:migrate`, `user:create`, `test:integration`, among others), which is outside the launcher.

**Launcher.** The api and worker dev loops (`dev.mjs`) and the servers Playwright starts (api and both Next.js servers) run through the launcher, which replaces itself with `node <entry>` (`process.execve`).

- The entry receives only the variables on that app's allowlist, plus `PATH` and `TMPDIR`; `scripts/run-with-env.mjs` is the source of truth for the lists.
- For api and worker, each value comes from the parent environment if set (an empty string counts) and otherwise from the root `.env`.
- Web mode never reads `.env`: its values come only from the parent environment.
- Every other inherited variable (including `NODE_OPTIONS`, `AWS_*` and `HOME`) and the rest of `.env` are not forwarded, so the bootstrap, owner, fixture and migration credentials never reach launcher-started processes. Allowlisted runtime credentials such as `DATABASE_URL`, `S3_*` and `REDIS_URL` are passed.
- Processes started any other way, such as `apps/web`'s `dev` script, are not covered.
- Unit tests check the allowlists against `.env.example` and that no privileged name is allowlisted; they do not compare them with the `packages/config` schemas.

`process.execve` is experimental in Node 24 and does not exist on Windows or IBM i, so this workflow requires Node 24.22.1 on macOS or Linux. The launcher is not available elsewhere, and if the exec itself fails Node aborts the process.

**Test credentials.** They live in a separate gitignored `.env.test` (contract: `.env.test.example`), which only `test:integration` and the e2e account tooling load; dev scripts, `infra:*`, `db:migrate`, `user:create`, and every app never do. `test:integration` needs it: the fixture seeds and cleans up test data on `DATABASE_FIXTURE_URL`, and the catalog security tests inspect PostgreSQL on `DATABASE_BOOTSTRAP_URL`. Both are required and neither falls back to `DATABASE_URL` or to the other, so a missing one fails naming the variable.

Copy it once: `cp .env.test.example .env.test`. The values are the same development-only placeholders as `.env.example`, matching the Compose stack.

Never commit `.env.test` or put real credentials in `.env.test.example`; use the local Compose values only.

| Variable | Read by | Rule |
| --- | --- | --- |
| `NODE_ENV` | api, worker | `development`, `test`, or `production` |
| `API_PORT`, `API_HOST` | api | port 1-65535; explicit bind address (`127.0.0.1` locally, never all interfaces) |
| `WEB_ORIGIN` | api | the one origin allowed to make unsafe requests: a bare origin, `https` in production |
| `TRUSTED_PROXY_HOPS` | api | 0-3; 0 when the API is reached directly; mandatory in production (see [Proxy topology](#proxy-topology-and-cookies)) |
| `API_INTERNAL_URL` | web (build **and** run time) | bare origin of the API; optional, defaults to `http://127.0.0.1:3001`. The `/api/*` rewrite takes it at `next build` (changing it needs a rebuild); the upload Route Handler reads it from the running server's environment (a restart is enough). Set the same value for both, see below |
| `REDIS_URL` | worker | `redis://` or `rediss://` URL |
| `DATABASE_URL` | api, `user:create` | `postgres://` or `postgresql://` URL; the application role `contextvault_app` |
| `DATABASE_WORKER_URL` | worker, `test:integration` | `postgres://` or `postgresql://` URL; the ingestion-worker role `contextvault_worker` |
| `DATABASE_MIGRATION_URL` | `db:migrate`, `user:create` | `postgres://` or `postgresql://` URL; `contextvault_owner`: owns the schema, not a superuser, bound by row-level security on forced tables. Never given to a running app |
| `DATABASE_FIXTURE_URL` | test tooling (`.env.test`) | `postgres://` or `postgresql://` URL; `contextvault_fixture` (BYPASSRLS, data changes only): seeds and cleanup. Refused when `NODE_ENV=production`; never falls back to `DATABASE_URL` |
| `DATABASE_BOOTSTRAP_URL` | test tooling (`.env.test`) | `postgres://` or `postgresql://` URL; the bootstrap superuser (`POSTGRES_USER`), for catalog probes only. Same rules as above |
| `S3_ENDPOINT` | api | bare `http://` or `https://` origin (no path, query, or credentials); `https` in production |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | api | non-empty |
| `S3_REGION` | api | optional, defaults to `us-east-1` |

The api requires `S3_*` at startup (the `DocumentStore` adapter, M1.3b); the worker needs nothing but Redis. `POSTGRES_*` (including `POSTGRES_APP_PASSWORD`) and `REDIS_PASSWORD` are read by Docker Compose only. A
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
pnpm run db:check           # committed migrations match the Drizzle schema
pnpm run test:integration   # API in-process, Redis, and PostgreSQL tenant isolation (needs `infra:up`, `db:migrate`, `.env`, `.env.test`)
pnpm run build
pnpm run infra:smoke        # needs `infra:up` and a worker build
pnpm exec playwright install --with-deps --only-shell chromium   # once per machine
pnpm run test:e2e           # needs `build`, `infra:up`, `db:migrate`, `.env`; serves web on 127.0.0.1:3100 and the built API on 3001, each through the launcher
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
- `infra/postgres/init.sql` enables the `vector` extension, `init-roles.sh` creates the application role `contextvault_app`, and `roles.sql` creates `contextvault_owner` and `contextvault_fixture` and makes the owner own the database objects, all on first initialisation of an empty volume. `POSTGRES_OWNER_PASSWORD` and `POSTGRES_FIXTURE_PASSWORD` must be set in `.env` before that first start (initialisation stops with a message naming them otherwise). A volume created before these roles existed keeps its old roles: see [Moving an existing volume](#moving-an-existing-volume-to-the-role-model).
- The S3 bucket (`S3_BUCKET`) is created by `pnpm run infra:up` (`scripts/infra-bucket.mjs`, idempotent) and nowhere else. The API checks once at start that the bucket exists and is accessible (`HeadBucket`) and refuses to start otherwise, logging `STORAGE_MISCONFIGURED` (missing bucket or refused credentials) or `STORAGE_UNAVAILABLE` (provider unreachable or failing), never the bucket name. It never creates a bucket or changes permissions: in production, create a private bucket first. SeaweedFS creates a missing bucket on an authenticated `PutObject` by default (spike S5), so Compose starts it with `-s3.autoCreateBucket=false`: a put to a missing bucket now fails with `NoSuchBucket` (`storage.rejected`), whether the bucket was mistyped or disappeared while the API runs. `infra-bucket.mjs` only issues a bucket PUT, refuses any non-loopback `S3_ENDPOINT`, and passes credentials to curl on stdin so they never appear in the process list or in an error. After pulling this change, `pnpm run infra:up` recreates the `s3` container (data and the bucket are kept).
- `infra:up` can take about 30 seconds on a restart with existing data: SeaweedFS waits for its topology to load before accepting writes.
- Ports 5432, 6379, and 8333 must be free; stop a local Postgres or Redis first.
- Updating an image: change the tag and digest together (`docker buildx imagetools inspect <image:tag>`), then run `infra:smoke`.

## Database

PostgreSQL has five roles. The application role and the ingestion-worker role are used at run time.

| Role | Attributes | Used by | Variable |
| --- | --- | --- | --- |
| `POSTGRES_USER` (bootstrap) | superuser | volume initialisation, `infra:roles`, catalog probes in tests | `DATABASE_BOOTSTRAP_URL` (`.env.test`) |
| `contextvault_owner` | NOSUPERUSER, NOBYPASSRLS; owns the database objects | `db:migrate`, `user:create` | `DATABASE_MIGRATION_URL` |
| `contextvault_fixture` | NOSUPERUSER, BYPASSRLS; data changes on `public` tables only, no DDL, owns nothing | test seeds, cleanup, e2e account tooling | `DATABASE_FIXTURE_URL` (`.env.test`) |
| `contextvault_app` | NOSUPERUSER, NOBYPASSRLS; `SELECT`/`INSERT` plus the reviewed grants | api | `DATABASE_URL` |
| `contextvault_worker` | NOSUPERUSER, NOBYPASSRLS; reads lifecycle metadata across workspaces, writes only inside the workspace it asserts (migration 0008) | worker (from the dispatcher increment) | `DATABASE_WORKER_URL` |

`contextvault_worker` is created by `init-roles.sh` on a fresh volume, from `POSTGRES_WORKER_PASSWORD`. A volume that predates it gets it from `pnpm run infra:roles` (run it before `db:migrate`; migration 0007 fails without the role): the role is created only if missing, so an existing worker keeps its credential, and only its attributes, timeouts and `CONNECT`/`USAGE` are brought back to the documented state. `infra:roles` needs `POSTGRES_WORKER_PASSWORD` in `.env`; `infra:roles:rollback` leaves the worker alone.

The worker's `app.workspace_id` is asserted by the worker process, not proved to the database. It stops bugs and forged job payloads from crossing workspaces; it does not protect against someone who holds the worker credential, who can assert any workspace and write there. Guard `DATABASE_WORKER_URL` like the application role's, and see the [threat model](threat-model.md).

`processed` is a temporary, non-searchable end state: the worker's update policy refuses `ready` until M1.6 activates versions. M1.6 must change the status `CHECK`, that policy and the pinned policy tests together.

The application role owns no table, has no `BYPASSRLS`, and cannot run DDL. Row-level security policies scope every row to the user and workspace set for the current transaction. The owner is bound by `FORCE ROW LEVEL SECURITY` too (it sees no rows of a forced table), but it can still change policies and grants, so its credential belongs to `db:migrate` and `user:create` only. New tables created by the owner give the fixture role data access automatically and the application role nothing; new functions are not executable by `PUBLIC` until a migration grants it.

```bash
pnpm run db:generate   # after editing packages/db/src/schema: writes SQL to infra/migrations; review it
pnpm run db:migrate    # applies pending migrations; running it twice is a no-op
pnpm run db:check      # fails if the schema and the migrations disagree
```

Migrations never run at API or worker startup. `DATABASE_MIGRATION_URL` belongs to the `db:migrate` command only: lint rejects reading it from `apps/*`, and a deployment should not provide it to the API or worker. Hand-written statements that Drizzle cannot generate
(`FORCE ROW LEVEL SECURITY`, grants) go in a migration created with `drizzle-kit generate --custom`.

### Backing up and restoring the local database

Take a backup before any role change, and prove it restores before relying on it. Keep the files outside the repository: the globals file holds password hashes, and the dump holds your data.

```bash
mkdir -p ~/contextvault-backups
docker compose --env-file .env -f infra/compose.yaml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -C' > ~/contextvault-backups/contextvault.dump
docker compose --env-file .env -f infra/compose.yaml exec -T postgres \
  sh -c 'pg_dumpall -U "$POSTGRES_USER" --globals-only' > ~/contextvault-backups/globals.sql   # roles; optional
```

Prove it in a separate, disposable Compose project (its own name, volume and ports: copy the stack to a scratch directory or pass an override file for the ports; never reuse the `contextvault` project). Start only `postgres` there so the roles are created by the same init scripts, then:

```bash
docker compose -p restore-check ... exec -T postgres \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d postgres --clean --if-exists --create --exit-on-error' < ~/contextvault-backups/contextvault.dump
```

- **Prerequisites.** The target needs the roles the dump refers to (`contextvault_app`, and `contextvault_owner` and `contextvault_fixture` for a dump taken after the role transition); a volume initialised from this repository's Compose file has them with the `.env` passwords, so the globals file is only for a cluster that was not. Restore as `POSTGRES_USER`.
- **`--clean --create` drops and recreates the database.** Use it on a disposable target only.
- **Compare.** Row counts per table, the migration journal count, and a content hash per table (`md5` of the ordered rows) against the source. Restoring a dump taken before the transition into a new-model instance works too; ownership then still belongs to `POSTGRES_USER` until `infra:roles` runs there.

Checked on synthetic data, both directions (before and after the transition): row counts, content hashes of all nine tables and the migration journal were identical, and so was the catalog (owners, grants, policies, `FORCE` flags, roles).

### Moving an existing volume to the role model

Roles are created only on a new volume. To bring an existing one (data kept) to the role model, with the stack running and a verified backup in hand:

```bash
# 1. add POSTGRES_OWNER_PASSWORD and POSTGRES_FIXTURE_PASSWORD to .env (see .env.example)
pnpm run infra:roles --project=contextvault                       # changes nothing: prints the target and a token
pnpm run infra:roles --project=contextvault --confirm=<token>     # copy the token by hand, after reading the target
# 2. in .env set DATABASE_MIGRATION_URL to the contextvault_owner URL; in .env.test set
#    DATABASE_FIXTURE_URL to the contextvault_fixture URL (values: .env.example, .env.test.example)
pnpm run db:migrate             # a no-op
```

`--project` is required on every call and is passed to Docker as `-p`, so no environment variable can redirect the command; say which project you mean before looking at the token. It refuses (before any SQL is sent) unless the project's postgres container is running and was started from this checkout's `infra/compose.yaml`, `.env` names the same database and user as the container, `NODE_ENV` is not `production`, the server is a superuser connection, and the token matches the server (`<project>/<database>@<server id>`); the server id is checked again inside the transaction. The change is one transaction: a failure leaves the database as it was.

Until step 2, the old URLs keep working, but the role-model tests fail: they require each URL to authenticate as its own role. To undo (ownership back to `POSTGRES_USER`, both roles dropped, data untouched), then point the URLs back at `POSTGRES_USER`:

```bash
pnpm run infra:roles:rollback --project=contextvault              # same two steps: dry run, then --confirm=...
```

Rollback refuses if either role is missing, and, changing nothing, if the owner still owns an object it did not move. It does not give `PUBLIC` back `EXECUTE` on the trigger function (the transition removes it so an existing database matches a fresh one). Reverting a Git commit does not change a database: use these commands.

Passwords reach the script through its input, never a command line. Every run sets both role passwords from `.env`, so changing a value there and re-running `infra:roles` rotates that password; a run that fails changes nothing, so the database keeps the old password until a run succeeds. `POSTGRES_APP_PASSWORD` is used only when the volume is first created.

### Privileged variables and the local runtime environment

`POSTGRES_PASSWORD` (bootstrap), `POSTGRES_OWNER_PASSWORD`, `POSTGRES_FIXTURE_PASSWORD` and `DATABASE_MIGRATION_URL` are not forwarded by the launcher, so a process started through it (api and worker dev loops, Playwright servers) does not receive them; a process started another way is not covered (see [Environment](#environment)). Playwright starts its API and both Next.js servers (ports 3100 and 3101) through the launcher. This covers the servers only: the Playwright runner, the e2e account seeder and `test:integration` run with their own, wider environment (including `.env.test` credentials such as `DATABASE_FIXTURE_URL`).

**Verified 2026-10-30** on Node 24.22.1 in the isolated `cv-test` environment: `pnpm run build` passed and Playwright E2E passed 42/42, with the API and Next.js servers started through the launcher. The worker runtime was not verified. Linux CI remains unverified.

## User accounts

There is no registration or password-reset endpoint. The operator creates accounts and resets passwords from a terminal:

```bash
pnpm run user:create -- --email ada@example.com [--workspace-name "Research"]
pnpm run user:create -- --email ada@example.com --reset-password
```

- The password is prompted for twice on the terminal without echo. It is never accepted as an argument, and there is no fallback to piped stdin or an environment variable: without an interactive terminal the command refuses. Passwords follow the login policy (12-128 characters, NFKC-normalised); the email is normalised exactly as at login.
- `user:create` uses both connections: `DATABASE_MIGRATION_URL` (owner role) to write the user and credential, and `DATABASE_URL` (application role, under the new user's own context) to create the personal workspace and owner membership. It refuses to run when `DATABASE_URL` is not a least-privileged role. `--reset-password` needs only `DATABASE_URL`.
- Creation is three committed steps (user, workspace, credential); the credential comes last, so an account that can log in always has its workspace. If the command is interrupted, the half-created user cannot log in; run the same command again and it finishes the missing steps. An account that already has a password is refused, and `--workspace-name` is ignored (with a message saying so) when the user already has a workspace. Concurrent runs for one email take turns on a per-user transaction lock, so they never create two initial workspaces.
- `--reset-password` replaces the hash and revokes every session of that user in one transaction. It is also the emergency revoke: run it with a new password to sign a user out everywhere.
- The command prints only a result line or a fixed error; it never prints passwords, hashes, tokens, or connection strings. Run it only on a trusted terminal: shell history and process lists do not contain the password, but a screen recorder would.

## Signing in, sessions, and cookies

```bash
# through the web origin (what a browser does); Origin is mandatory on unsafe methods
curl -i -c jar.txt -H 'Origin: http://127.0.0.1:3000' -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"<your password>"}' http://127.0.0.1:3000/api/auth/login
curl -b jar.txt http://127.0.0.1:3000/api/auth/me         # user and workspaces
curl -b jar.txt -X POST -H 'Origin: http://127.0.0.1:3000' http://127.0.0.1:3000/api/auth/logout
```

- Routes: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /workspaces/:workspaceId`, and the public `GET /health`. Everything else needs a session. There is no auth UI yet (M1.8).
- The session cookie is `cv_session` in development and `__Host-cv_session` (`Secure`, no `Domain`) in production; both are `HttpOnly`, `SameSite=Lax`, `Path=/`, valid 7 days absolute and 24 hours idle. Its value is a random token; only a hash is stored. Logging in again, logging out, and a password reset revoke the old session.
- Unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) must send `Origin` exactly equal to `WEB_ORIGIN`; browsers do this, `curl` needs `-H 'Origin: ...'`. A missing or foreign origin gets 403. Unknown email and wrong password both give the same 401; a workspace you do not belong to, one that does not exist, and a malformed id all give the same 404.
- Too many failed logins return 429 with `Retry-After`.

### Proxy topology and cookies

```text
browser ─► web :3000 (Next.js, rewrites /api/* → API_INTERNAL_URL) ─► api 127.0.0.1:3001
```

- The browser only ever talks to the web origin, so the cookie is host-only to it and the API sends no CORS headers. The API listens on `API_HOST` (loopback locally) and `TRUSTED_PROXY_HOPS=0`: it ignores `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto`, and `Secure` follows `NODE_ENV`, not the request scheme.
- Next's rewrite does not append a client address, so locally (and behind the rewrite alone) the API sees the web server as the only client. The per-address login limit therefore acts as one shared bucket; the per-account limit does not depend on it.
- **Production limits (not deployed yet):** serve web over HTTPS and set `WEB_ORIGIN` to that `https` origin; keep the API reachable only from the web server; set `TRUSTED_PROXY_HOPS` to the exact number of trusted proxies in front of the API that append the real client address (never 1 if the API can be reached directly). The login limiter is in memory and valid for a **single API instance**: run one instance until a Redis-backed limiter exists.
- **Uploads (M1.3):** the `/api/*` rewrite buffers bodies and fails above 10 MB, so uploads use a dedicated streaming Route Handler (`POST /api/workspaces/{workspaceId}/uploads`, raw body, `Content-Length` required, 10 MiB maximum; contract in [ADR 0009](adr/0009-streaming-upload-transport.md)). The handler reads `API_INTERNAL_URL` at runtime and forwards only `Cookie`, `Origin`, and the file description. The API endpoint behind it is not built yet.
- **One variable, two readers.** `next build` freezes `API_INTERNAL_URL` into the `/api/*` rewrite; `next start` ignores a different value for it (verified on Next 16.4.3: built with the default, started with another origin, the rewrite still reached the default). The upload handler reads the value when the server starts, so a restart is enough for it but does not move the rewrite. A build and a server started with different values send ordinary calls and uploads to different origins. Keep one source for both (the same environment file or CI variable for the build step and the run step), and after changing it rebuild, then restart.

## Git hooks

Enable the git hooks once per clone:

```bash
node scripts/git/conventions.mjs install-hooks
```

The `pre-push` hook runs `pnpm run typecheck`, so push from a shell where `node -v` prints `v24.22.1`.
On another Node version, `engineStrict` makes the hook fail by design.
The hook also applies migrations and runs the integration tests, so start the infrastructure first (`pnpm run infra:up`).

## Troubleshooting

- `Invalid environment variables`: compare `.env` with `.env.example`; the message names each bad variable.
- `pnpm install` rejects the Node version: run `node -v`; it must print `v24.22.1`.
- `infra:up` times out or a port is taken: stop a local Postgres or Redis, then see `pnpm run infra:logs`.
- Worker exits at boot: Redis is unreachable or `REDIS_URL` has the wrong password; run `pnpm run infra:ps`.
