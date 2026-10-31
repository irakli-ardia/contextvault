# 0010 — Isolated test stack for pre-push checks

Status: accepted — 2026-10-31

## Context

Integration and E2E tests create and delete rows, objects and queue jobs. They read `.env` and `.env.test` from the repository, so a pre-push run touches whatever those files point at, which is the development stack. A missing variable, a shell export or a direct `.env` read inside a test silently falls back to development data.

## Decision

Pre-push test commands run through `scripts/checks/with-test-stack.mjs`, against the existing `cv-test` Compose stack. No new stack, and the wrapper never starts, stops or resets containers.

- **Explicit location:** `CV_TEST_ENV_DIR` names a directory outside the repository holding the stack's own `.env` and `.env.test`. There is no default. The repository, a path inside it, or env files that resolve to the repository's own are refused.
- **Complete, loopback, not development:** every database, Redis, S3 and application name the commands need must be present, including `NODE_ENV` (`test` or `development`) and `API_INTERNAL_URL`, which the web app would otherwise default to the development API. Endpoints must be well-formed loopback URLs with an explicit port, no query string or fragment, valid percent-encoding, and `localhost`, `127.0.0.1` and `[::1]` count as one host when compared with development endpoints; must not use the default ports (5432, 6379, 8333, and 3001, the development API) or any endpoint in the repository's own `.env` files, and must not reuse a development credential. All database URLs name one database. `S3_ENDPOINT` and `API_INTERNAL_URL` are bare origins (no path, trailing slash, userinfo, query or fragment); database and Redis URLs need a non-empty password. `S3_BUCKET` must differ from the bucket in the repository's `.env`, `.env.test` and `.env.example`.
- **One API endpoint:** `API_PORT` is a plain port that is not a development port (including the one in the repository's `.env`) and equals the port of `API_INTERNAL_URL`. Playwright derives the API server, its health URL and the E2E client from them (`apps/web/e2e/stack-env.ts`), with no fallback to 3001, and refuses to load if the web build's frozen `/api/*` rewrite (`.next/routes-manifest.json`) targets another origin. Build through the wrapper so `next build` sees the stack's `API_INTERNAL_URL`.
- **Paths:** the repository, the directory and each env file are resolved with `realpathSync.native`, so symlinks and case variants on case-insensitive volumes (macOS) are compared as the same path.
- **Rebuilt child environment:** a short platform allowlist plus the verified files, restricted to names the repository declares. Nothing else is inherited (no `DATABASE_*`, `PG*`, `REDIS_*`, `S3_*`, `AWS_*`, `NODE_OPTIONS`). Names that only the development `.env` files define are set to an empty string, so a later `--env-file-if-exists=.env` cannot reintroduce them: Node never overrides a variable that is already set. `CV_TEST_STACK_VERIFIED=1` makes `run-with-env.mjs` ignore `.env`, and E2E helpers read only the injected variables. `CV_TEST_STACK_VERIFIED` is a launch convention, not a credential (a shell can set it): `playwright.config.ts` and every seeding, cleanup and S3 helper use it only to fail early, and the guarantees stay in the wrapper's endpoint checks and the PostgreSQL identity marker. The child's exit status is the child's code, or 128 plus the signal number when a signal ended it.
- **NODE_ENV:** the stack's `NODE_ENV` (`test`) reaches unit, integration and API processes unchanged; the API server under Playwright keeps `development` and the two `next start` servers are pinned to `production`, as before the wrapper. `next build` 16.4.3 under `NODE_ENV=test` was built and started locally without error or warning, so the build keeps the stack value and no build-specific policy was added; if a future Next release rejects it, run the build as `env NODE_ENV=production` through the wrapper.
- **Identity before execution:** the PostgreSQL database comment must equal `CV_TEST_DB_MARKER` from the verified files; Redis must accept `AUTH` and `PING`; the S3 bucket must answer a signed `HEAD`. That confirms reachability and that the credentials are authorised, not the storage server's cryptographic identity; the bucket name, endpoint and credential checks above are what keep it from being the development store. Each check has a timeout. The PostgreSQL and S3 checks run in child processes whose environment is `PATH` alone (no proxy, `PG*`, `AWS_*`, `HOME`), with `curl -q --noproxy '*'`, explicit endpoints and credentials on stdin; a timeout kills the child. Any failure, including a missing marker, ends with exit 1 and the command never starts.
- **Quiet output:** messages name a key or a check, never a value, a URL or a driver error.

The marker is set once on the `cv-test` database with `COMMENT ON DATABASE`, as a separate, reviewed step; the wrapper only reads it. A development database has no such comment, so it fails closed even if every other check were fooled.

## Consequences

- The pre-push hook calls the wrapper for migrations, integration, build and E2E; run bare, E2E commands fail on the missing injected variables instead of using development storage.
- A developer needs one external directory and the marker step per machine.
- The checks prove the stack's identity, not its health beyond reachability; health beyond that is not checked by the hook.
