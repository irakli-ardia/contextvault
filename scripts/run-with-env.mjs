#!/usr/bin/env node
// Starts an app's built entry with an explicit environment: usage `run-with-env.mjs
// <api|worker|web> <entry.mjs> [args...]`. The launcher replaces itself (execve) with `node <entry>`, so the entry
// keeps the launcher's pid, stdio, working directory, exit code and signals, and there is no
// wrapper to forward, orphan or double-signal. The entry receives only the app's allowlisted names
// plus the platform names below, never the parent's whole environment and never the rest of `.env`,
// so the owner, fixture and bootstrap credentials in `.env` cannot reach a runtime process. Each
// value is the parent's (an empty string counts, so a blank still wins) or else the repo-root
// `.env`'s. The web entry never reads `.env` (Next does not either): its values are the parent's.
//
// process.execve is experimental in Node 24 and absent on Windows and IBM i; engines pins Node
// 24.22.1 and development and CI run macOS and Linux. If the exec itself fails, Node aborts the
// process natively (no JS error), which is why the executable is always process.execPath.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const S3 = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];

// Keep in step with the loaders in packages/config (apiEnvSchema, workerEnvSchema, webEnvSchema).
export const ALLOWLISTS = {
  api: [
    "NODE_ENV",
    "API_PORT",
    "API_HOST",
    "WEB_ORIGIN",
    "TRUSTED_PROXY_HOPS",
    "DATABASE_URL",
    ...S3,
  ],
  worker: ["NODE_ENV", "REDIS_URL"],
  web: ["NODE_ENV", "API_INTERNAL_URL"],
};

// Taken from the parent only, never from `.env`. PATH lets the entry resolve executables and TMPDIR
// keeps os.tmpdir() on the caller's directory. HOME is left out on purpose: SDKs read
// credential and config files under it.
export const PLATFORM = ["PATH", "TMPDIR"];

export const readDotEnv = (path) => {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
};

export const buildEnv = (app, file, parent) => {
  const env = {};
  for (const name of PLATFORM) if (parent[name] !== undefined) env[name] = parent[name];
  for (const name of ALLOWLISTS[app]) {
    const value = parent[name] ?? file[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

const run = (argv) => {
  const [app, entry, ...args] = argv;
  // A leading "-" would make Node read the entry as one of its own flags (--env-file=.env would
  // load the whole file), so it is refused before anything is executed.
  if (!Object.hasOwn(ALLOWLISTS, app) || entry === undefined || entry.startsWith("-")) {
    console.error("usage: run-with-env.mjs <api|worker|web> <entry.mjs> [args...]");
    process.exit(2);
  }
  const envFile = fileURLToPath(new URL("../.env", import.meta.url));
  try {
    // biome-ignore lint/style/noProcessEnv: the launcher is the one place that decides what of the parent environment a runtime process may see
    const env = buildEnv(app, app === "web" ? {} : readDotEnv(envFile), process.env);
    process.execve(process.execPath, [process.execPath, entry, ...args], env);
  } catch (error) {
    // A bad env value's error text quotes the whole environment, so only the error code is shown.
    const code = /^[A-Z_]{1,40}$/.test(error?.code ?? "") ? ` (${error.code})` : "";
    console.error(`run-with-env: could not start the entry${code}`);
    process.exit(1);
  }
};

// import.meta.url is symlink-resolved, argv[1] is not (macOS /var, /tmp).
if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) run(process.argv.slice(2));
