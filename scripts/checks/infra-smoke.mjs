#!/usr/bin/env node
// Smoke test for the local Compose stack (`pnpm run infra:up` first): pgvector is installed, Redis
// answers, S3 round-trips an object with signed requests, and the built worker connects and
// shuts down cleanly. Needs `.env` and a worker build. No SDKs, no network beyond loopback.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const env = parseEnv(readFileSync(".env", "utf8"));
const compose = ["compose", "--env-file", ".env", "-f", "infra/compose.yaml"];
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const step = (name, check) => {
  check();
  console.log(`ok  ${name}`);
};
const expect = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
};

step("postgres has pgvector", () => {
  const sql = "select extversion from pg_extension where extname='vector'";
  const version = run("docker", [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    env.POSTGRES_USER,
    "-d",
    env.POSTGRES_DB,
    "-tAc",
    sql,
  ]);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("vector extension missing");
});

step("redis answers PING", () => {
  expect(run("docker", [...compose, "exec", "-T", "redis", "redis-cli", "ping"]), "PONG", "ping");
});

step("s3 round trip and access control", () => {
  const url = `${env.S3_ENDPOINT}/${env.S3_BUCKET}`;
  const sign = (secret) => [
    "--aws-sigv4",
    `aws:amz:${env.S3_REGION}:s3`,
    "--user",
    `${env.S3_ACCESS_KEY_ID}:${secret}`,
  ];
  const auth = sign(env.S3_SECRET_ACCESS_KEY);
  const wrong = sign("wrong-secret");
  const curl = (...args) => run("curl", ["-fsS", "--max-time", "10", ...args]);
  const status = (...args) =>
    run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", ...args]);
  const put = (...args) => ["-X", "PUT", "--data-binary", "x", ...args];
  const body = "0123456789-contextvault-smoke";

  // 409 = bucket already exists from an earlier run.
  const created = status(...auth, "-X", "PUT", url);
  if (created !== "200" && created !== "409") throw new Error(`create bucket: status ${created}`);
  curl(...auth, "-X", "PUT", "--data-binary", body, `${url}/smoke.txt`);
  expect(curl(...auth, `${url}/smoke.txt`), body, "get");
  expect(curl(...auth, "-r", "0-9", `${url}/smoke.txt`), body.slice(0, 10), "range");

  // Unauthenticated and wrong-secret requests are refused and change nothing.
  expect(status(`${url}/smoke.txt`), "403", "anonymous get");
  expect(status(...put(`${url}/anon.txt`)), "403", "anonymous put");
  expect(status("-X", "DELETE", `${url}/smoke.txt`), "403", "anonymous delete");
  expect(status(...wrong, `${url}/smoke.txt`), "403", "wrong-secret get");
  expect(status(...wrong, ...put(`${url}/bad.txt`)), "403", "wrong-secret put");
  expect(status(...auth, `${url}/anon.txt`), "404", "refused anonymous put left an object");
  expect(status(...auth, `${url}/bad.txt`), "404", "refused wrong-secret put left an object");

  curl(...auth, "-X", "DELETE", `${url}/smoke.txt`);
  expect(status(...auth, `${url}/smoke.txt`), "404", "get after delete");
});

await new Promise((resolve, reject) => {
  const worker = spawn("node", ["--env-file=.env", "apps/worker/dist/main.mjs"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const timer = setTimeout(() => {
    worker.kill("SIGKILL");
    reject(new Error("worker did not become ready in 10s"));
  }, 10_000);
  worker.stdout.on("data", (chunk) => {
    if (String(chunk).includes("worker ready")) worker.kill("SIGTERM");
  });
  worker.on("error", reject);
  worker.on("exit", (code, signal) => {
    clearTimeout(timer);
    if (code === 0) resolve();
    else reject(new Error(`worker exited with code ${code} signal ${signal}`));
  });
}).then(() => console.log("ok  worker connects to redis and exits 0 on SIGTERM"));
