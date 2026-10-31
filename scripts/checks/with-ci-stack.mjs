#!/usr/bin/env node
// GitHub Actions counterpart of with-test-stack.mjs (docs/adr/0010). A runner has no external
// `cv-test` stack, so the workflow marks the stack it just provisioned and the launcher refuses to
// run anything unless that mark is found on the configured database and bucket:
//   with-ci-stack.mjs mark            after infra:up, before db:migrate: refuses a database or bucket
//                                     that is not fresh, then writes a random `cv-ci-<hex>` marker to
//                                     the database comment and to a bucket object, and exports it
//                                     through $GITHUB_ENV
//   with-ci-stack.mjs run <cmd...>    verifies both marks, then starts <cmd> with
//                                     CV_TEST_STACK_VERIFIED=1 (the same convention the E2E helpers use)
// The marker is per run and never stored in a file, so a development database or bucket cannot
// carry it, and it is distinct from the local CV_TEST_DB_MARKER. CI and GITHUB_ACTIONS are not
// consulted: they are forgeable and would prove nothing. Output names a check, never a value.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { probes, quote, runProbe } from "./with-test-stack.probes.mjs";

const { Client } = createRequire(new URL("../../packages/db/package.json", import.meta.url))("pg");

export const MARKER = /^cv-ci-[0-9a-f]{32}$/;
const KEY = ".cv-ci-marker";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const NEEDED = [
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "DATABASE_FIXTURE_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
];

export class CiStackError extends Error {}
const fail = (message) => {
  throw new CiStackError(message);
};

function checkEndpoints(env) {
  for (const name of NEEDED) if (!env[name]) fail(`${name} is missing`);
  for (const name of NEEDED.filter((n) => n.endsWith("_URL") || n.endsWith("_ENDPOINT"))) {
    if (!URL.canParse(env[name]) || !LOOPBACK.has(new URL(env[name]).hostname)) {
      fail(`${name} is not a loopback endpoint`);
    }
  }
  const databases = new Set(
    ["DATABASE_URL", "DATABASE_MIGRATION_URL", "DATABASE_FIXTURE_URL"].map((n) => {
      const url = new URL(env[n]);
      return `${url.hostname}:${url.port}${url.pathname}`;
    }),
  );
  if (databases.size !== 1) fail("DATABASE_* URLs must name one database");
}

// Signed curl against the bucket, credentials on stdin like the wrapper's probe.
const bucket = (env, args, key = "") =>
  runProbe(
    "curl",
    [
      "-q",
      "-s",
      "-f",
      "--max-time",
      "5",
      "--noproxy",
      "*",
      "--aws-sigv4",
      `aws:amz:${env.S3_REGION}:s3`,
      "--config",
      "-",
      ...args,
      `${env.S3_ENDPOINT}/${env.S3_BUCKET}${key}`,
    ],
    `user = "${quote(env.S3_ACCESS_KEY_ID)}:${quote(env.S3_SECRET_ACCESS_KEY)}"\n`,
  );

export const defaults = {
  // The database comment as the app role sees it (the wrapper's probe: PATH-only child process).
  comment: (env) => probes.postgres(env.DATABASE_URL),
  object: (env) => bucket(env, [], `/${KEY}`),
  async prepare(env, marker) {
    const client = new Client({ connectionString: env.DATABASE_MIGRATION_URL, ssl: false });
    await client.connect();
    try {
      const { rows } = await client.query(
        `select shobj_description(d.oid, 'pg_database') as comment,
           (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
               and n.nspname not like 'pg_toast%') as tables
         from pg_database d where d.datname = current_database()`,
      );
      if (rows[0].comment || rows[0].tables !== 0) fail("database is not freshly provisioned");
      const listing = await bucket(env, ["-G", "--data-urlencode", "list-type=2"]);
      if (listing.includes("<Key>")) fail("bucket is not freshly provisioned");
      // The marker is hex under a fixed prefix: safe to inline in the statement.
      await client.query(
        `comment on database ${client.escapeIdentifier(new URL(env.DATABASE_MIGRATION_URL).pathname.slice(1))} is '${marker}'`,
      );
    } finally {
      await client.end();
    }
    await bucket(env, ["-X", "PUT", "--data-binary", marker], `/${KEY}`);
  },
};

/** Marks a freshly provisioned stack; returns the marker. */
export async function mark(env, io = defaults) {
  checkEndpoints(env);
  if (!env.GITHUB_ENV || !existsSync(env.GITHUB_ENV)) fail("GITHUB_ENV is not a runner file");
  const marker = `cv-ci-${randomBytes(16).toString("hex")}`;
  try {
    await io.prepare(env, marker);
  } catch (error) {
    fail(error instanceof CiStackError ? error.message : "marking failed");
  }
  appendFileSync(env.GITHUB_ENV, `CV_CI_DB_MARKER=${marker}\n`);
  return marker;
}

/** Fails closed unless the database comment and the bucket object both equal this run's marker. */
export async function verify(env, io = defaults) {
  checkEndpoints(env);
  const marker = env.CV_CI_DB_MARKER;
  if (!marker) fail("CV_CI_DB_MARKER is missing");
  if (!MARKER.test(marker) || marker === env.CV_TEST_DB_MARKER) fail("CV_CI_DB_MARKER is invalid");
  const seen = await Promise.all([
    io.comment(env).catch(() => fail("postgres check failed")),
    io.object(env).catch(() => fail("s3 identity marker is missing")),
  ]);
  if (!seen[0]) fail("postgres identity marker is missing");
  if (seen[0] !== marker) fail("postgres identity marker does not match");
  if (seen[1] !== marker) fail("s3 identity marker does not match");
}

const runChild = (command, args, env) =>
  new Promise((done) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.on("error", () => done(127));
    child.on("exit", (code, signal) => done(code ?? 128 + (constants.signals[signal] ?? 1)));
  });

export async function main(argv, env, deps = {}) {
  const [mode, command, ...args] = argv;
  try {
    if (mode === "mark" && !command) {
      await mark(env, deps.io);
      return 0;
    }
    if (mode === "run" && command && !command.startsWith("-")) {
      await verify(env, deps.io);
      return await (deps.run ?? runChild)(command, args, { ...env, CV_TEST_STACK_VERIFIED: "1" });
    }
    console.error("usage: with-ci-stack.mjs mark | run <command> [args...]");
    return 2;
  } catch (error) {
    console.error(
      `with-ci-stack: ${error instanceof CiStackError ? error.message : "unexpected failure"}`,
    );
    return 1;
  }
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // biome-ignore lint/style/noProcessEnv: the launcher is the one place that decides what the child may inherit
  process.exitCode = await main(process.argv.slice(2), process.env);
}
