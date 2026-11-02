// Bundled by orphan-discovery.mjs: re-exports the production factories whose SQL is measured, plus
// the drizzle dialect that renders that SQL, so the harness runs the real statements and no copy.
export { PgDialect } from "../../packages/db/node_modules/drizzle-orm/pg-core/index.js";
export { createOrphanRepository } from "../../packages/db/src/repositories/ingestion/orphan-repository.ts";
export { createOrphanSource } from "../../packages/db/src/repositories/ingestion/orphan-source.ts";
