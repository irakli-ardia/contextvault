// Refuses to run the retrieval benchmark unless it is positively on the isolated test stack.
// CV_TEST_STACK_VERIFIED alone is only a flag a shell can set, and this script writes through the
// RLS-exempt fixture role, so it re-checks what with-test-stack.mjs verified: both database URLs
// are loopback, off the development port and name one database, and that database carries the
// stack's identity marker. Messages name a variable or a rule, never a value.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEV_PORT = "5432";

function target(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is malformed`);
  }
  if (!LOOPBACK.has(url.hostname)) throw new Error(`${name} is not a loopback endpoint`);
  if (!url.port || url.port === DEV_PORT)
    throw new Error(`${name} needs an explicit non-development port`);
  if (url.pathname.length < 2) throw new Error(`${name} needs a database name`);
  return `${url.port}${url.pathname}`;
}

/** Environment checks that need no connection. */
export function assertStackEnv({ verified, marker, appUrl, fixtureUrl }) {
  if (verified !== "1") {
    throw new Error("run through scripts/test-stack/with-test-stack.mjs (isolated stack only)");
  }
  if (!marker) throw new Error("CV_TEST_DB_MARKER is missing");
  if (target("DATABASE_URL", appUrl) !== target("DATABASE_FIXTURE_URL", fixtureUrl)) {
    throw new Error("DATABASE_URL and DATABASE_FIXTURE_URL must name one database");
  }
}

/** The connected database must carry the marker the wrapper verified (set by a controlled step). */
export async function assertStackIdentity(db, marker) {
  const { rows } = await db.query(
    "select shobj_description(oid, 'pg_database') as marker from pg_database where datname = current_database()",
  );
  if (rows[0]?.marker !== marker) throw new Error("postgres identity marker does not match");
}
