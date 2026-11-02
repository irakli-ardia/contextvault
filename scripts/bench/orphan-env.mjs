// Disposable PostgreSQL 18 for the orphan-discovery benchmark, and the only way the benchmark
// scripts reach a database. Approved as a one-time, narrow exception to with-test-stack.mjs: that
// script and its protections are untouched, and nothing here reads a URL, a password or any
// DATABASE_* variable from the environment. The container is created here with random credentials,
// bound to 127.0.0.1 on a random port, backed by tmpfs only, and removed on every exit path.
//
// Every connection goes through `connect(role)`, which refuses unless it positively identifies the
// server as this run's container: host, port, database name, a random marker stored in the database
// comment, the server's system identifier and the engine version. A mismatch aborts the run.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
// The driver belongs to packages/db; a variable keeps the root from declaring it.
const driver = "pg";
const { Client } = require(driver);

// Same digest as infra/compose.yaml (already local; never pulled here).
const IMAGE =
  "pgvector/pgvector:0.8.7-pg18@sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11";
const DATABASE = "cv_bench";
const HOST = "127.0.0.1";
// Ports of the dev and cv-test stacks; refusing them is belt and braces on top of the marker.
const FORBIDDEN_PORTS = new Set([5432, 6379, 8333, 55433, 56379, 58333]);
const POSTGRES_FLAGS = [
  "shared_buffers=256MB",
  "autovacuum=off",
  "fsync=off",
  "synchronous_commit=off",
  "track_io_timing=on",
  "max_wal_size=2GB",
];

const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const secret = () => randomBytes(18).toString("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launch(name, superuserPassword) {
  const run = docker(
    ...["run", "-d", "--rm", "--name", name, "--label", "cv.bench=orphan-discovery"],
    ...["-p", `${HOST}::5432`, "--tmpfs", "/var/lib/postgresql:rw,size=2g"],
    ...["--shm-size=512m", "--memory=4g"],
    ...["-e", `POSTGRES_PASSWORD=${superuserPassword}`, "-e", `POSTGRES_DB=${DATABASE}`, IMAGE],
    ...POSTGRES_FLAGS.flatMap((flag) => ["-c", flag]),
  );
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr.trim().slice(0, 300)}`);
}

/** Returns the host port, or throws when the container is not the isolated one we asked for. */
// fallow-ignore-next-line complexity
function verifyIsolation(name) {
  const inspect = JSON.parse(docker("inspect", name).stdout)[0];
  const binding = inspect.NetworkSettings.Ports["5432/tcp"]?.[0];
  const port = Number(binding?.HostPort);
  const problems = [
    [inspect.Config.Labels["cv.bench"] !== "orphan-discovery", "label"],
    [binding?.HostIp !== HOST, "port is not bound to 127.0.0.1 only"],
    [!Number.isInteger(port) || FORBIDDEN_PORTS.has(port), "host port"],
    [inspect.Mounts.some((mount) => mount.Type !== "tmpfs"), "non-tmpfs mount"],
    [Boolean(inspect.HostConfig.Binds?.length), "bind mount"],
  ].filter(([failed]) => failed);
  if (problems.length > 0) throw new Error(`isolation check failed: ${problems[0][1]}`);
  return { port, id: inspect.Id };
}

async function waitReady(name) {
  // initdb runs a temporary socket-only server first; TCP answering inside means the final one.
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (docker("exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres").status === 0)
      return;
    await sleep(1000);
  }
  throw new Error("PostgreSQL did not become ready");
}

async function connectWithRetry(client) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.connect();
    } catch (error) {
      if (attempt >= 20) throw error;
      await sleep(500);
    }
  }
}

// Mirrors infra/postgres/{init-roles.sh,roles.sql}: owner (DDL, NOBYPASSRLS), app and worker with
// the production limits. Seeding is done by the bootstrap superuser, which is RLS-exempt like the
// fixture role.
const rolesSql = (passwords, marker) => `
  create role contextvault_owner login nosuperuser nocreatedb nocreaterole nobypassrls
    noinherit password '${passwords.owner}';
  create role contextvault_app login nosuperuser nocreatedb nocreaterole nobypassrls
    noinherit password '${passwords.app}';
  alter role contextvault_app set statement_timeout = '15s';
  alter role contextvault_app set idle_in_transaction_session_timeout = '30s';
  create role contextvault_worker login nosuperuser nocreatedb nocreaterole nobypassrls
    noinherit password '${passwords.worker}';
  alter role contextvault_worker set statement_timeout = '15s';
  alter role contextvault_worker set idle_in_transaction_session_timeout = '30s';
  revoke all on database ${DATABASE} from public;
  revoke all on schema public from public;
  grant connect on database ${DATABASE} to contextvault_app, contextvault_worker;
  grant usage on schema public to contextvault_app, contextvault_worker;
  alter database ${DATABASE} owner to contextvault_owner;
  alter schema public owner to contextvault_owner;
  comment on database ${DATABASE} is '${marker}'`;

const identitySql = `select current_database() as db, current_user as who,
  inet_server_port() as port, current_setting('server_version_num')::int as version,
  (select system_identifier::text from pg_control_system()) as sysid,
  (select shobj_description(oid, 'pg_database') from pg_database
     where datname = current_database()) as marker`;

export function startBench() {
  const name = `cv-bench-orphan-${randomBytes(4).toString("hex")}`;
  const marker = `cv-bench-orphan:${secret()}`;
  const passwords = Object.fromEntries(
    ["postgres", "owner", "app", "worker"].map((role) => [role, secret()]),
  );
  let removed = false;
  const stop = () => {
    if (removed) return;
    removed = true;
    docker("rm", "-f", "-v", name);
  };
  // Registered before the container exists, so no failure path can leave it running.
  process.on("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      stop();
      process.exit(130);
    });
  }

  launch(name, passwords.postgres);
  const info = { name, image: IMAGE };
  const client = (role) =>
    new Client({
      host: HOST,
      port: info.port,
      database: DATABASE,
      user: role === "postgres" ? "postgres" : `contextvault_${role}`,
      password: passwords[role],
      ssl: false,
      connectionTimeoutMillis: 5000,
    });

  // fallow-ignore-next-line complexity
  const connect = async (role) => {
    const conn = client(role);
    conn.on("error", () => undefined);
    await conn.connect();
    const [id] = (await conn.query(identitySql)).rows;
    const mismatches = [
      id.db !== DATABASE,
      id.who !== (role === "postgres" ? "postgres" : `contextvault_${role}`),
      id.port !== 5432,
      Math.floor(id.version / 10000) !== 18,
      id.marker !== marker,
      info.systemIdentifier !== undefined && id.sysid !== info.systemIdentifier,
    ];
    if (mismatches.some(Boolean)) {
      await conn.end().catch(() => undefined);
      throw new Error("connection guard: server is not this run's disposable benchmark container");
    }
    info.systemIdentifier ??= id.sysid;
    info.serverVersionNum = id.version;
    return conn;
  };

  const bootstrap = async () => {
    try {
      Object.assign(info, verifyIsolation(name));
    } catch (error) {
      stop();
      throw error;
    }
    await waitReady(name);
    // The bootstrap superuser exists only in this container; its identity is the container we just
    // verified (inspect), and every later connection is checked against the marker set here.
    const admin = client("postgres");
    admin.on("error", () => undefined);
    await connectWithRetry(admin);
    try {
      await admin.query(rolesSql(passwords, marker));
    } finally {
      await admin.end();
    }
  };

  return { info, connect, bootstrap, stop };
}

/** Dangling volumes belong to other projects: snapshot before, compare after, never remove. */
export const danglingVolumes = () =>
  docker("volume", "ls", "-q", "--filter", "dangling=true")
    .stdout.trim()
    .split("\n")
    .filter(Boolean);

export const containersNamed = (name) =>
  docker("ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}")
    .stdout.trim()
    .split("\n")
    .filter(Boolean);

const migrationsFolder = new URL("../../infra/migrations", import.meta.url).pathname;

/** Applies 0000-0012 as the database owner through drizzle's migrator, as `db:migrate` does. */
export async function migrate(bench) {
  const { drizzle } = require("drizzle-orm/node-postgres");
  const { migrate: run } = require("drizzle-orm/node-postgres/migrator");
  const owner = await bench.connect("owner");
  try {
    await run(drizzle(owner), { migrationsFolder });
    const { rows } = await owner.query(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );
    return rows[0].n;
  } finally {
    await owner.end();
  }
}
