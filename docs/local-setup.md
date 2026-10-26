# Local setup

The repository currently holds the toolchain, a `packages/config` skeleton, and CI; the applications and
infrastructure arrive in later milestones, so there is nothing to run yet beyond the checks below.

## Prerequisites

- Node.js `24.22.1` (pinned in `.node-version`)
- pnpm `12.15.0` (pinned in `package.json` as `packageManager`)
- Docker with Compose, from the infrastructure milestone onward (PostgreSQL with pgvector, Redis, S3-compatible storage)

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
pnpm run typecheck
pnpm run test
node scripts/checks/docs-check.mjs
```

Real secrets live in `.env` (gitignored); `.env.example` lists every variable the project reads.

## Git hooks

Enable the git hooks once per clone:

```bash
node scripts/git/conventions.mjs install-hooks
```

The `pre-push` hook runs `pnpm run typecheck`, so push from a shell where `node -v` prints `v24.22.1`.
On another Node version, `engineStrict` makes the hook fail by design.
