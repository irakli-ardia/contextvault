import {
  loadBootstrapEnv,
  loadDatabaseEnv,
  loadFixtureEnv,
  loadMigrationEnv,
  loadWorkerDatabaseEnv,
} from "@contextvault/config";
import pg from "pg";
import { postgresErrorCode } from "./repositories/workspaces/postgres-error";

// Role-model tests connect as each role of the five-role model; the URLs come from the same
// loaders the tooling uses, so a test can only reach a role through its documented variable.
export const ROLES = {
  owner: "contextvault_owner",
  fixture: "contextvault_fixture",
  app: "contextvault_app",
  worker: "contextvault_worker",
} as const;

export interface RolePools {
  readonly owner: pg.Pool;
  readonly fixture: pg.Pool;
  readonly app: pg.Pool;
  readonly worker: pg.Pool;
  readonly bootstrap: pg.Pool;
  close(): Promise<void>;
}

export function openRolePools(): RolePools {
  const make = (connectionString: string) => {
    const pool = new pg.Pool({ connectionString, max: 1 });
    pool.on("error", () => undefined);
    return pool;
  };
  const pools = {
    owner: make(loadMigrationEnv().DATABASE_MIGRATION_URL),
    fixture: make(loadFixtureEnv().DATABASE_FIXTURE_URL),
    app: make(loadDatabaseEnv().DATABASE_URL),
    worker: make(loadWorkerDatabaseEnv().DATABASE_WORKER_URL),
    bootstrap: make(loadBootstrapEnv().DATABASE_BOOTSTRAP_URL),
  };
  return {
    ...pools,
    close: async () => {
      await Promise.all(Object.values(pools).map((pool) => pool.end()));
    },
  };
}

/** Runs the statements in a transaction that is always rolled back; returns the SQLSTATE or undefined. */
export async function attempt(pool: pg.Pool, text: string): Promise<string | undefined> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(text);
    return undefined;
  } catch (error) {
    return postgresErrorCode(error) ?? "unknown";
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

export async function scalar<T>(pool: pg.Pool, text: string, values: unknown[] = []): Promise<T> {
  const row = (await pool.query<{ v: T }>(text, values)).rows[0];
  if (row === undefined) throw new Error("query returned no row");
  return row.v;
}

/** Runs `statement`, then `check`, in one rolled-back transaction: for statements PostgreSQL only warns about (GRANT without grant option). */
export async function effectOf<T>(pool: pg.Pool, statement: string, check: string): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(statement);
    const row = (await client.query<{ v: T }>(check)).rows[0];
    if (row === undefined) throw new Error("check returned no row");
    return row.v;
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}
