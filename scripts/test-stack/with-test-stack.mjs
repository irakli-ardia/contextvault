#!/usr/bin/env node
// Runs a command against the isolated `cv-test` stack and nothing else: usage
// `CV_TEST_ENV_DIR=<dir> with-test-stack.mjs <command> [args...]`. <dir> (outside this repository,
// no default) holds the stack's own `.env` and `.env.test`. Before the command starts, every
// check below must pass, otherwise it never runs (docs/adr/0010). The child gets a rebuilt
// environment: a short platform allowlist plus the verified files, never the parent's database,
// Redis, S3 or AWS variables, and every other name in the repository's own `.env` files is blanked
// so a later `--env-file` cannot bring a development value back. Output names keys and checks,
// never values. It never starts, stops or resets containers.
//
// The PostgreSQL identity marker is the database comment (readable by every role) and must equal
// CV_TEST_DB_MARKER from the verified files; it is set by a separate, controlled step.

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { probes } from "./with-test-stack.probes.mjs";
import { fail, PLAIN, readEnv, StackError, URLS, validate } from "./with-test-stack.rules.mjs";

// Execution plumbing only; credentials and proxies are never passed through.
export const PASSTHROUGH = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "PLAYWRIGHT_BROWSERS_PATH",
];
export const TIMEOUT_MS = 8000;

// The native realpath also canonicalises letter case (case-insensitive APFS), which the JS one does not.
const canonical = (path) => realpathSync.native(path);

// Whole path segments only: a sibling directory named `..x` is not outside, and `repo-other` is not inside.
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Reads, checks and merges the external files; returns the verified values. Pure apart from reads. */
export function loadTestEnv(dirValue, repoRoot) {
  if (!dirValue) fail("CV_TEST_ENV_DIR is required (no default)");
  const repo = canonical(repoRoot);
  let dir;
  try {
    dir = canonical(dirValue);
  } catch {
    fail("CV_TEST_ENV_DIR does not exist");
  }
  if (inside(repo, dir)) fail("CV_TEST_ENV_DIR is the repository or inside it");
  const merged = {};
  for (const name of [".env", ".env.test"]) {
    const file = join(dir, name);
    if (!existsSync(file)) fail(`${name} is missing in CV_TEST_ENV_DIR`);
    const real = canonical(file);
    if (inside(repo, real)) fail(`${name} resolves into the repository`);
    Object.assign(merged, readEnv(real));
  }
  // Only names the repository declares are carried over (no NODE_OPTIONS or similar via the file).
  const declared = new Set([...PLAIN, ...Object.keys(URLS)]);
  for (const name of [".env.example", ".env.test.example"]) {
    for (const key of Object.keys(readEnv(join(repo, name)) ?? {})) declared.add(key);
  }
  const env = Object.fromEntries(Object.entries(merged).filter(([key]) => declared.has(key)));
  validate(env, repo);
  return env;
}

export function buildChildEnv(verified, parent, repoRoot) {
  const env = {};
  // Names only the development files define are blanked: an empty string still wins over --env-file.
  for (const file of [".env", ".env.test"]) {
    for (const key of Object.keys(readEnv(join(repoRoot, file)) ?? {})) env[key] = "";
  }
  Object.assign(env, verified);
  for (const name of PASSTHROUGH) if (parent[name] !== undefined) env[name] = parent[name];
  env.CV_TEST_STACK_VERIFIED = "1";
  return env;
}

const bounded = async (what, work, timeoutMs) => {
  let timer;
  try {
    await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } catch (error) {
    fail(`${what} check failed${error?.message === "timeout" ? " (timed out)" : ""}`);
  } finally {
    clearTimeout(timer);
  }
};

export async function verifyStack(env, p = probes, timeoutMs = TIMEOUT_MS) {
  let marker;
  await bounded(
    "postgres",
    async () => {
      marker = await p.postgres(env.DATABASE_URL);
    },
    timeoutMs,
  );
  if (marker == null || marker === "") fail("postgres identity marker is missing");
  if (marker !== env.CV_TEST_DB_MARKER) fail("postgres identity marker does not match");
  await bounded("redis", () => p.redis(env.REDIS_URL), timeoutMs);
  await bounded("s3", () => p.s3(env), timeoutMs);
}

const runChild = (command, args, env, cwd) =>
  new Promise((done) => {
    const child = spawn(command, args, { env, cwd, stdio: "inherit" });
    const forward = (signal) => child.kill(signal);
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, forward);
    child.on("error", () => done(127));
    // A signal death maps to 128 + signal number, as a shell reports it.
    child.on("exit", (code, signal) => done(code ?? 128 + (constants.signals[signal] ?? 1)));
  });

export async function main(argv, parent, deps = {}) {
  const repoRoot = deps.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const [command, ...args] = argv;
  if (!command || command.startsWith("-")) {
    console.error("usage: CV_TEST_ENV_DIR=<dir> with-test-stack.mjs <command> [args...]");
    return 2;
  }
  try {
    const verified = loadTestEnv(parent.CV_TEST_ENV_DIR, repoRoot);
    await verifyStack(verified, deps.probes ?? probes, deps.timeoutMs);
    return await (deps.run ?? runChild)(
      command,
      args,
      buildChildEnv(verified, parent, repoRoot),
      repoRoot,
    );
  } catch (error) {
    console.error(
      `with-test-stack: ${error instanceof StackError ? error.message : "unexpected failure"}`,
    );
    return 1;
  }
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // biome-ignore lint/style/noProcessEnv: the wrapper is the one place that decides what the child may inherit
  process.exitCode = await main(process.argv.slice(2), process.env);
}
