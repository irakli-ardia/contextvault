# Engineering standards

These rules keep the codebase small, readable and safe. Most of them are checked by tools. The rest are checked in code review.

## Simplicity

Write the simplest code that is correct and fits the current architecture.

- Do not add an abstraction, a wrapper, a generic type or a config option for a case that does not exist yet.
- Keep control flow flat. Use early returns instead of deep nesting. Do not nest ternaries.
- Prefer plain, explicit code to clever one-liners.
- Do not add a dependency when the platform or an installed package already does the job.
- Do not optimize before you have a measurement.

Shorter code is never a reason to weaken security, correctness, transactions, concurrency guarantees or error handling.

## File size

- A source file should usually have fewer than 200 lines. Between 200 and 250 lines needs a reason.
- 250 lines is the limit for production source files. Biome fails the lint run above it.
- A test file should usually have fewer than 250 lines. 400 lines is the limit, and Biome fails the lint run above it. Split a long test file by behavior.
- Split a file when it has more than one job, not to reach a number. Do not move code into a new file only to pass the limit.

## Repository structure

- Organise by feature first, then by role. A feature directory (`documents/`, `auth/`) owns everything for that feature; do not create directories named after a technology across features.
- Inside an app feature, transport code (controllers, request parsing, error-to-status mapping, middleware) lives in `http/`. Providers, injection tokens and policies stay at the feature root. Middleware applied to one route belongs to that route's feature and is attached in the app module with `forRoutes` (`closeConnection` in `documents/http/`); only middleware for every route is app-wide.
- Unit tests sit beside the file they test. Integration tests and the fixtures only they use sit together in an `integration/` directory owned by the feature (`documents/integration/`), optionally split by area (`integration/uploads/`). A flat `src/integration/` at a workspace root is a catch-all and is rejected; `src/integration/<area>/` is allowed. Browser tests stay in `apps/web/e2e/`.
- A file used by one module lives in that module. Move it up only when a second module needs it, to the lowest directory both share.
- Dependencies point inward: apps depend on packages, never the reverse; a package never imports an app; `packages/domain` imports no other workspace package. `.fallowrc.json` enforces the workspace zones (`pnpm run arch`).
- Production code never imports from an `integration/` directory, and in `packages/db` and `apps/*` never from `testing/` (test-only support; some files back the `@contextvault/db/testing*` entries); Biome `noRestrictedImports` enforces it (tests and test-support files may).
- An integration test imports only its own area's files and files outside integration areas. Support shared by two or more areas goes in the workspace's `testing/` (in `packages/db`, only some of it backs the `@contextvault/db/testing*` exports). `pnpm run structure` fails a relative import into another area.
- `pnpm run structure` also enforces integration test placement, the `.ts` extension, and the no-generic-names rule. `LEGACY_FILES` lists, file by file, the integration tests not yet moved. It may only shrink, and a stale entry fails the check.

## TypeScript

The compiler runs in strict mode (see `tsconfig.base.json`). Do not relax these settings for one package.

- No `any`, no `as` assertions, no non-null `!`, no `@ts-ignore`.
- Take `unknown` at a boundary and narrow it with a Zod schema or a type guard.
- Model states with discriminated unions and explicit interfaces. Use `satisfies` to check a value without changing its type.
- Use a generic only when a plain type does not work.

## Naming

| Thing | Convention | Example |
| --- | --- | --- |
| Files and directories | kebab-case, ASCII | `upload-document.ts` |
| Test files | unit tests beside the code (`.unit.test.ts`); integration tests in the module's `integration/` directory (`.integration.test.ts`) | `login-limiter.unit.test.ts` |
| Variables, functions | camelCase; functions start with a verb | `resolveSession` |
| Booleans | read as a question | `isExpired`, `hasAccess` |
| Classes, types, interfaces | PascalCase, named for the domain | `UploadRepository` |
| Constants | camelCase; `UPPER_SNAKE` only for injection tokens | `maxUploadBytes`, `SESSION_TOKENS` |
| Error classes | PascalCase, state the failed condition; extend the domain error base | `AccountExists` |
| Database tables, columns | snake_case, plural table names | `document_versions` |
| Database indexes, checks | `<table>_<columns or rule>` with an `_idx` suffix for indexes | `documents_workspace_created_idx` |
| Tests | `describe` names the unit; `it` states the behavior | `it("rejects a second login attempt")` |

Use the terms in the glossary exactly as written, in code and in file names. Do not use `utils`, `helpers`, `common` or `manager` as a file or folder name.

## Comments

Write a comment only when the code cannot explain the reason: a hidden constraint, an invariant, a security decision or a trade-off. Explain why, not what. Keep it short and plain. Do not comment every function.

## Avoid duplication

Before you add a function, type or helper, search the repository. Reuse or extend what exists when that is simpler and safer. Add a new abstraction only when it has a clear benefit. Do not merge code just because it looks alike; two pieces that encode different rules should stay apart.

## Automated checks

| Rule | Tool |
| --- | --- |
| Formatting, file size, file names, no `any`, no `!`, no `@ts-ignore`, no import cycles | Biome (`pnpm run lint`) |
| No `as` assertions, unhandled promises | oxlint (`pnpm run lint`) |
| Strict types | TypeScript (`pnpm run typecheck`) |
| Package boundaries, dead code, complexity | fallow (`pnpm run arch`, `pnpm run dead-code`) |
| Branch names and commit titles | `scripts/git/conventions.mjs`, git hooks, CI |
| No local-only files in the repository | `scripts/checks/tracked-files.mjs`, pre-commit hook, CI |
| Broken links in documentation | `scripts/checks/docs-check.mjs` |
| File placement and generic names | `scripts/checks/structure-check.mjs` (`pnpm run structure`), pre-push hook, CI |
| Production code importing integration files | Biome `noRestrictedImports` (`biome.json`) |

Code review covers the rest: whether an abstraction is needed, whether a comment explains why, whether a name fits the domain, and whether similar code already exists.

## Documentation style

Write documentation in plain English with short sentences. Use concrete examples and exact technical terms. Do not use marketing language or claim more than the code does.
