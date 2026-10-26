# 0007 — Monorepo and toolchain

Status: accepted — 2026-10-26

## Context

Three deployables share configuration and, later, domain code. The toolchain must be reproducible on a fresh clone and resist supply-chain drift.

## Decision

- **Layout:** pnpm workspaces (`apps/*`, `packages/*`) with `pnpm -r`; no Turborepo. M0 creates only `packages/config`; other packages arrive with the code that needs them. Package boundaries are enforced by fallow.
- **Versions:** Node 24.22.1 (`.node-version`) and pnpm 12.15.0 (`packageManager`), with `engineStrict`, exact versions (`saveExact`), a frozen lockfile in CI, `minimumReleaseAge`, and an install-script allowlist (`allowBuilds`). A scoped, commented `overrides` entry is allowed only to ship a security fix that upstream has not yet released. TypeScript 6.0.3 rather than 7: the NestJS CLI declares `~6.0`, and the other tools accept it.
- **Build:** internal packages are source-first (`exports` point at `src/*.ts`). `api` and `worker` are bundled with `tsdown`, because plain `tsc` emit would leave runtime imports of workspace TypeScript.
- **Quality:** Biome formats and lints, type-aware oxlint with built-in rules only, fallow checks boundaries and dead code. Unit tests (`*.unit.test.ts`) need no I/O; integration tests (`*.integration.test.ts`) use the Compose stack; Playwright covers the browser (Chromium only).

## Consequences

- A fresh clone reproduces the same dependency tree and the same checks locally and in CI.
- Source-first packages need a bundler for deployables and cannot be published as-is.
- `tsdown` is pre-1.0 and pinned; revisit if it blocks an upgrade.
- Task caching is absent; add a task runner only after a measured build-time problem.

## Alternatives considered

- Turborepo or Nx — caching not yet needed.
- `tsc` project references with `dist/` — more configuration for no current benefit.
- A custom lint plugin — built-in rules cover the required invariants.
