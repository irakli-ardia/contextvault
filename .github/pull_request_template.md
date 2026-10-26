## What and why

<!-- One or two sentences. Link the build-plan item or plan file. -->

## Checks run locally

| Check | Result |
| --- | --- |
| `pnpm run lint` | |
| `pnpm run typecheck` | |
| `pnpm exec vitest run --changed origin/master` | |
| `node scripts/checks/docs-check.mjs` | |
| Runtime verification | <!-- what you exercised, where --> |

Skipped checks and why:

## Docs updated

- [ ] README / setup docs, if behaviour or setup changed

Add `do-not-merge` once after opening if any check above is unverified; remove it only after every relevant check passed on the final commit.
