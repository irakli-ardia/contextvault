// What a test configuration must satisfy before with-test-stack.mjs may run anything. Every message
// names a key or a rule, never a value.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export class StackError extends Error {}
export const fail = (message) => {
  throw new StackError(message);
};

const POSTGRES = ["postgres:", "postgresql:"];
const HTTP = ["http:", "https:"];
export const URLS = {
  DATABASE_URL: POSTGRES,
  DATABASE_WORKER_URL: POSTGRES,
  DATABASE_MIGRATION_URL: POSTGRES,
  DATABASE_FIXTURE_URL: POSTGRES,
  DATABASE_BOOTSTRAP_URL: POSTGRES,
  REDIS_URL: ["redis:"],
  S3_ENDPOINT: HTTP,
  WEB_ORIGIN: HTTP,
  // Optional for the web app (it defaults to the development API port), required here so a test
  // run cannot fall back to that default.
  API_INTERNAL_URL: HTTP,
};
export const PLAIN = [
  "NODE_ENV",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "API_PORT",
  "API_HOST",
  "TRUSTED_PROXY_HOPS",
  "CV_TEST_DB_MARKER",
];
const SECRETS = ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
// 3001 is the development API (API_PORT and API_INTERNAL_URL default to it).
const DEV_PORTS = new Set(["5432", "6379", "8333", "3001"]);
const ORIGIN_ONLY = ["S3_ENDPOINT", "API_INTERNAL_URL"];

export const readEnv = (path) => {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

// localhost, 127.0.0.1 and [::1] are one machine, so they share one key when endpoints are compared.
const endpoint = (value) => {
  try {
    const url = new URL(value);
    const host = url.hostname; // IPv6 comes bracketed
    return { url, host, key: `${LOOPBACK.has(host) ? "loopback" : host}:${url.port}` };
  } catch {
    return null;
  }
};

// Single development values compared with the test stack's, by variable name.
const SINGLE = { API_PORT: "ports", S3_BUCKET: "buckets" };

// A plain secret is compared byte for byte; only a URL password is percent-decoded.
const secretOf = (key, value, parsed) =>
  parsed ? (decode(parsed.url.password) ?? parsed.url.password) : SECRETS.includes(key) && value;

// Endpoints, credentials, API port and bucket of the repository's own (development) files.
function developmentValues(repo) {
  const dev = { endpoints: new Set(), secrets: new Set(), ports: new Set(), buckets: new Set() };
  const entries = [".env", ".env.test", ".env.example", ".env.test.example"].flatMap((file) =>
    Object.entries(readEnv(join(repo, file)) ?? {}),
  );
  for (const [key, value] of entries) {
    if (key in SINGLE) dev[SINGLE[key]].add(value);
    const parsed = key in URLS ? endpoint(value) : null;
    if (parsed) dev.endpoints.add(parsed.key);
    const secret = secretOf(key, value, parsed);
    if (secret) dev.secrets.add(secret);
  }
  return dev;
}

// The shape of one URL, whatever stack it names.
function parseUrl(name, value, protocols) {
  const parsed = endpoint(value);
  if (!parsed || !protocols.includes(parsed.url.protocol)) fail(`${name} is malformed`);
  const { url } = parsed;
  // Query parameters (host, options, sslmode, ...) could re-route or reconfigure a connection.
  if (/[?#]/.test(value)) fail(`${name} must not have query parameters or a fragment`);
  // An origin carries no path, credentials, query or fragment (a trailing slash is a path).
  if (ORIGIN_ONLY.includes(name) && url.origin !== value) fail(`${name} must be a bare origin`);
  const password = decode(url.password);
  if (password === null || decode(url.username) === null) {
    fail(`${name} has malformed percent-encoding`);
  }
  return { ...parsed, password };
}

// Returns the database identity (host, port, name) of a database URL, else null.
function checkUrl(name, value, protocols, dev) {
  const { url, host, key, password } = parseUrl(name, value, protocols);
  if (!LOOPBACK.has(host)) fail(`${name} is not a loopback endpoint`);
  if (!url.port) fail(`${name} needs an explicit port`);
  if (DEV_PORTS.has(url.port) || dev.endpoints.has(key)) {
    fail(`${name} matches a development endpoint`);
  }
  if (password && dev.secrets.has(password)) fail(`${name} carries a development credential`);
  if ((name === "REDIS_URL" || name.startsWith("DATABASE_")) && !password) {
    fail(`${name} needs a password`);
  }
  if (!name.startsWith("DATABASE_")) return null;
  if (url.pathname.length < 2) fail(`${name} needs a database name`);
  return `${key}${url.pathname}`;
}

// One API endpoint, never a development port, and one test bucket.
function checkApiAndBucket(env, dev) {
  if (!/^[1-9]\d{0,4}$/.test(env.API_PORT) || Number(env.API_PORT) > 65535) {
    fail("API_PORT is invalid");
  }
  if (DEV_PORTS.has(env.API_PORT) || dev.ports.has(env.API_PORT)) {
    fail("API_PORT is a development port");
  }
  if (env.API_PORT !== new URL(env.API_INTERNAL_URL).port) {
    fail("API_PORT and API_INTERNAL_URL disagree");
  }
  if (dev.buckets.has(env.S3_BUCKET)) fail("S3_BUCKET is the development bucket");
}

export function validate(env, repo) {
  for (const name of [...Object.keys(URLS), ...PLAIN]) if (!env[name]) fail(`${name} is missing`);
  const dev = developmentValues(repo);
  const databases = new Set();
  for (const [name, protocols] of Object.entries(URLS)) {
    const database = checkUrl(name, env[name], protocols, dev);
    if (database) databases.add(database);
  }
  if (databases.size !== 1) fail("DATABASE_* URLs must name one database");
  if (env.NODE_ENV !== "test" && env.NODE_ENV !== "development") {
    fail("NODE_ENV must be test or development");
  }
  checkApiAndBucket(env, dev);
  if (!LOOPBACK.has(env.API_HOST) && env.API_HOST !== "::1") fail("API_HOST is not loopback");
  for (const name of SECRETS)
    if (dev.secrets.has(env[name])) fail(`${name} is a development credential`);
}
