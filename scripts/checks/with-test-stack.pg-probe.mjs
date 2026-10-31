// Child of the PostgreSQL probe: the connection settings arrive as JSON on stdin and the database
// comment leaves as JSON on stdout. The parent kills this process on a timeout, so a hung server
// can never leave a socket or the wrapper hanging. Nothing is printed on failure.

import { createRequire } from "node:module";

// The root has no driver of its own; packages/db owns it.
const { Client } = createRequire(new URL("../../packages/db/package.json", import.meta.url))("pg");

let input = "";
for await (const chunk of process.stdin) input += chunk;

const client = new Client({ ...JSON.parse(input), ssl: false, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const { rows } = await client.query(
    "select shobj_description(oid, 'pg_database') as marker from pg_database where datname = current_database()",
  );
  process.stdout.write(JSON.stringify(rows[0]?.marker ?? null));
  await client.end();
} catch {
  process.exit(1);
}
