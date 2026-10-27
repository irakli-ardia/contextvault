import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index";

export type Database = NodePgDatabase<typeof schema>;
export type Executor = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DatabaseHandle {
  readonly db: Database;
  readonly close: () => Promise<void>;
}

export function createDatabase(options: {
  connectionString: string;
  poolSize?: number;
}): DatabaseHandle {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.poolSize ?? 10,
    connectionTimeoutMillis: 5_000,
  });
  // An idle client that loses its connection emits 'error'; without a listener that crashes the
  // process. The pool discards the client, and the next checkout reconnects.
  pool.on("error", () => undefined);
  // A client checked out when its connection drops emits 'error' too, and the pool has no listener
  // for it then. The active query still rejects (the caller decides what that means, e.g. an
  // unknown COMMIT outcome); without this the event would be an uncaught exception.
  pool.on("connect", (client) => client.on("error", () => undefined));
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
