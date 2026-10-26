# Local setup

The application is not scaffolded yet, so there is nothing to install or run. Planned prerequisites:

- Node.js LTS and pnpm
- Docker with Compose (PostgreSQL with pgvector, Redis, S3-compatible storage)

Real secrets live in `.env` (gitignored); `.env.example` lists every variable the project reads.

Enable the git hooks once per clone:

```bash
node scripts/git/conventions.mjs install-hooks
```

Check the documentation:

```bash
node scripts/checks/docs-check.mjs
```
