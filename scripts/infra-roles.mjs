#!/usr/bin/env node
// Applies infra/postgres/roles.sql to the RUNNING Compose Postgres of a NAMED project: the owner
// and fixture roles, object ownership, grants. Idempotent; for a volume created before these roles
// existed (a fresh volume gets the same file from the entrypoint). `rollback` reverses it
// (ownership back to POSTGRES_USER, roles dropped). The file runs as one transaction (see its header).
//
// Target safety. The project is always named on the command line (--project=<name>) and passed to
// Docker as `-p`, so no ambient variable can redirect the command. Without `--confirm=<token>`
// nothing is changed: the script prints what it found and the token for exactly that server
// (`<project>/<database>@<system id>`). A token is not a substitute for knowing which project you
// mean: it is checked against the server, and the system id is checked again inside the
// transaction. Every refusal happens before the one call that carries SQL. Not interactive.
//
// Passwords are the first two stdin lines, read into the container shell's environment for psql
// (\getenv): never on a command line, never in this process's environment, redacted from output.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const USAGE = "Usage: infra-roles.mjs [rollback] --project=<compose project> [--confirm=<token>]";
const PASSWORDS = ["POSTGRES_OWNER_PASSWORD", "POSTGRES_FIXTURE_PASSWORD"];
// Read-only. The 8 fields: database, superuser?, version, system id, transition roles, tables.
const PROBE_SQL =
  "select current_database() || '|' || current_setting('is_superuser') || '|' || current_setting('server_version') || '|' || (select system_identifier from pg_control_system()) || '|' || (select count(*) from pg_roles where rolname in ('contextvault_owner', 'contextvault_fixture')) || '|' || (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r')";

class Refusal extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const named = (flag) => argv.find((arg) => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3);
  const known = (arg) =>
    arg === "rollback" || arg.startsWith("--project=") || arg.startsWith("--confirm=");
  const project = named("project");
  if (!argv.every(known) || project === undefined || !/^[a-z0-9][a-z0-9_-]*$/.test(project)) {
    throw new Refusal(USAGE, 2);
  }
  return { rollback: argv.includes("rollback"), project, confirm: named("confirm") };
}

function loadConfig(readFile, rollback) {
  let dotenv;
  try {
    dotenv = readFile(".env");
  } catch {
    throw new Refusal("No .env here: run from the repository root (cp .env.example .env).");
  }
  const env = parseEnv(dotenv);
  if (env.NODE_ENV === "production") throw new Refusal("Refusing: NODE_ENV=production in .env");
  const passwords = Object.fromEntries(PASSWORDS.map((name) => [name, env[name] ?? ""]));
  const missing = rollback ? undefined : PASSWORDS.find((name) => passwords[name] === "");
  if (missing) throw new Refusal(`${missing} is not set in .env (see .env.example)`);
  return { env, passwords };
}

// Which container, and does it belong to this project and this checkout's Compose file?
function checkContainer({ docker, realpath, compose, project }) {
  const ps = docker([...compose, "ps", "-q", "postgres"]);
  const container = ps.stdout.trim();
  if (ps.status !== 0 || container === "") {
    throw new Refusal(`The postgres service of project ${project} is not running.`);
  }
  let labels;
  try {
    labels = JSON.parse(
      docker(["inspect", "--format", "{{json .Config.Labels}}", container]).stdout,
    );
  } catch {
    throw new Refusal("Refusing: could not read the container's labels.");
  }
  if (labels["com.docker.compose.project"] !== project) {
    throw new Refusal(`Refusing: the container does not belong to project ${project}.`);
  }
  const resolved = (path) => {
    try {
      return realpath(path);
    } catch {
      return path;
    }
  };
  const files = (labels["com.docker.compose.project.config_files"] ?? "").split(",");
  if (!files.some((file) => resolved(file) === resolved("infra/compose.yaml"))) {
    throw new Refusal(
      "Refusing: the container was not started from this checkout's infra/compose.yaml.",
    );
  }
}

// Which server, and does it match .env? Read-only.
function probeServer({ docker, compose, env, rollback }) {
  const probe = docker([
    ...compose,
    "exec",
    "-T",
    "postgres",
    "sh",
    "-c",
    `printf '%s|%s\\n' "$POSTGRES_DB" "$POSTGRES_USER"; psql -X -A -t -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "${PROBE_SQL}"`,
  ]);
  const [identity, state] = probe.stdout.trim().split("\n");
  if (probe.status !== 0 || identity === undefined || state === undefined) {
    throw new Refusal(`Could not read the server identity:\n${probe.stderr}`);
  }
  const [containerDb, containerUser] = identity.split("|");
  const [database, superuser, version, systemId, roleCount, tableCount] = state.split("|");
  if (containerDb !== env.POSTGRES_DB || containerUser !== env.POSTGRES_USER) {
    throw new Refusal(
      "Refusing: POSTGRES_DB / POSTGRES_USER in .env differ from the running container's.",
    );
  }
  if (superuser !== "on")
    throw new Refusal("Refusing: POSTGRES_USER is not a superuser on this server.");
  // Interpolated into a shell command in applyRoles.
  if (!/^\d+$/.test(systemId ?? "")) {
    throw new Refusal("Refusing: the server's system identifier is not a number.");
  }
  if (rollback && roleCount !== "2") {
    throw new Refusal(
      `Refusing: rollback needs both transition roles, this server has ${roleCount}.`,
    );
  }
  return { database, version, systemId, roleCount, tableCount };
}

// The one call that carries SQL, with the identity re-checked inside the transaction.
function applyRoles({ docker, compose, rollback, passwords, sql, systemId }) {
  const read = PASSWORDS.map((name) => `IFS= read -r ${name};`).join(" ");
  return docker(
    [
      ...compose,
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      `${read} export ${PASSWORDS.join(" ")}; exec psql -X -v ON_ERROR_STOP=1 -v expect_system_identifier=${systemId} ${rollback ? "-v rollback=1 " : ""}-U "$POSTGRES_USER" -d "$POSTGRES_DB"`,
    ],
    `${PASSWORDS.map((name) => passwords[name]).join("\n")}\n${sql}`,
  );
}

function plan({ project, rollback, confirm }, server, out) {
  const { database, version, systemId, roleCount, tableCount } = server;
  const token = `${project}/${database}@${systemId}`;
  out.push(`Target: Compose project ${project}, database ${database}, PostgreSQL ${version}\n`);
  out.push(
    `        server ${systemId}, ${tableCount} tables, ${roleCount} of 2 transition roles exist\n`,
  );
  if (confirm === undefined) {
    const command = `pnpm run infra:roles${rollback ? ":rollback" : ""} --project=${project} --confirm=${token}`;
    out.push(
      `Nothing changed. To ${rollback ? "roll back" : "apply"} on exactly this server: ${command}\n`,
    );
    throw new Refusal("", 2);
  }
  if (confirm !== token)
    throw new Refusal("Refusing: --confirm does not match this server. Nothing changed.");
}

/**
 * @param {{ argv: string[], readFile: (path: string) => string,
 *   realpath: (path: string) => string,
 *   docker: (args: string[], input?: string) => { status: number | null, stdout: string, stderr: string } }} deps
 * `docker` is the only way out of this function; the call that carries `input` is the only one
 * that can change a database. Every refusal is a thrown `Refusal`, so none can fall through to it.
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
export function infraRoles({ argv, readFile, realpath, docker }) {
  const out = [];
  try {
    const args = parseArgs(argv);
    const { env, passwords } = loadConfig(readFile, args.rollback);
    const compose = [
      "compose",
      "-p",
      args.project,
      "--env-file",
      ".env",
      "-f",
      "infra/compose.yaml",
    ];
    checkContainer({ docker, realpath, compose, project: args.project });
    const server = probeServer({ docker, compose, env, rollback: args.rollback });
    plan(args, server, out);
    const applied = applyRoles({
      docker,
      compose,
      rollback: args.rollback,
      passwords,
      sql: readFile("infra/postgres/roles.sql"),
      systemId: server.systemId,
    });
    const redact = (text) =>
      Object.values(passwords).reduce(
        (acc, secret) => (secret ? acc.replaceAll(secret, "***") : acc),
        text,
      );
    out.push(redact(applied.stdout));
    if (applied.status !== 0)
      return { code: applied.status ?? 1, stdout: out.join(""), stderr: redact(applied.stderr) };
    out.push(args.rollback ? "roles rolled back\n" : "roles up to date\n");
    return { code: 0, stdout: out.join(""), stderr: redact(applied.stderr) };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return {
      code: error.code,
      stdout: out.join(""),
      stderr: error.message ? `${error.message}\n` : "",
    };
  }
}

// Not `import.meta.main` (Node 24.2+): where it is undefined this block would be skipped and the
// command would exit 0 having done nothing.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = infraRoles({
    argv: process.argv.slice(2),
    readFile: (path) => readFileSync(path, "utf8"),
    realpath: (path) => realpathSync(path),
    docker: (args, input) => {
      const run = spawnSync("docker", args, { input, encoding: "utf8" });
      return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
    },
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
