// Checks that must pass before the benchmark process touches any database or queue: the process
// environment holds nothing of another stack, both PostgreSQL roles and Redis are positively the
// containers this run created, and the worker role is the real, RLS-bound one. Messages name a rule,
// never a value.

import { assertRedisIdentity } from "./ingestion-bench-infra.mjs";
import { APP_STATEMENT_TIMEOUT } from "./keyword-experiment-checks.mjs";
import { assertStackEnv, assertStackIdentity } from "./retrieval-guard.mjs";

// Anything that could point the production config loaders at another database, queue or bucket.
const FOREIGN = /^(DATABASE|POSTGRES|PG|REDIS|S3|AWS|OPENAI|CV_)/i;

/** Removes every connection-shaped variable, then sets exactly the disposable stack's. Returns the removed names. */
export function isolateEnv(env, values) {
  const removed = Object.keys(env).filter((k) => FOREIGN.test(k));
  for (const key of removed) delete env[key];
  Object.assign(env, values);
  return removed;
}

/** The worker role must be the unprivileged one, under the production statement timeout. */
export async function assertWorkerRole(db) {
  const {
    rows: [role],
  } = await db.query(
    "select current_user as name, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
  );
  if (role?.name !== "contextvault_worker")
    throw new Error("connection is not contextvault_worker");
  if (role.rolsuper || role.rolbypassrls) throw new Error("worker role bypasses RLS");
  const {
    rows: [setting],
  } = await db.query("show statement_timeout");
  if (setting?.statement_timeout !== APP_STATEMENT_TIMEOUT) {
    throw new Error(`worker statement_timeout is not ${APP_STATEMENT_TIMEOUT}`);
  }
}

/** Loopback, off the development ports, one database for every URL; the marker proves identity. */
export async function assertIsolated({ urls, marker, fixture, workerRole, redis, redisUrl }) {
  assertStackEnv({ verified: "1", marker, appUrl: urls.app, fixtureUrl: urls.fixture });
  assertStackEnv({ verified: "1", marker, appUrl: urls.worker, fixtureUrl: urls.fixture });
  const queue = new URL(redisUrl);
  if (queue.hostname !== "127.0.0.1" || !queue.port || queue.port === "6379") {
    throw new Error("redis is not a loopback endpoint off the development port");
  }
  for (const client of [fixture, workerRole]) await assertStackIdentity(client, marker);
  await assertWorkerRole(workerRole);
  await assertRedisIdentity(redis, marker);
}
