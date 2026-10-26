import { loadMigrationEnv } from "@contextvault/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

// Run deliberately (`pnpm run db:migrate`) as the owner role; no app imports this file. Applied
// migrations are recorded, so a second run is a no-op.
async function main(): Promise<void> {
  const env = loadMigrationEnv();
  const client = new Client({ connectionString: env.DATABASE_MIGRATION_URL });
  await client.connect();
  try {
    await migrate(drizzle(client), {
      migrationsFolder: new URL("../../../infra/migrations", import.meta.url).pathname,
    });
  } finally {
    await client.end();
  }
}

main().then(
  () => console.log("migrations up to date"),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "migration failed");
    process.exitCode = 1;
  },
);
