#!/usr/bin/env node
// Creates the private development bucket after `infra:up` (idempotent). This is the only place a
// bucket is created: the API checks that S3_BUCKET exists at start and never creates it, so a
// typo cannot turn into a new bucket. It only issues a bucket PUT (it cannot delete or overwrite
// anything) and refuses any endpoint that is not loopback, so a production .env is never touched.
// Needs `.env`. The credentials go to curl on stdin, so they appear in neither the process list
// nor an error message.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const fail = (message) => {
  console.error(`infra-bucket: ${message}`);
  process.exit(1);
};

const env = parseEnv(readFileSync(".env", "utf8"));
const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
  fail("S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set in .env");
}
if (!URL.canParse(S3_ENDPOINT)) fail("S3_ENDPOINT is not a URL");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(S3_ENDPOINT).hostname)) {
  fail("S3_ENDPOINT is not a loopback address; create that bucket with your provider's tools");
}

let status;
try {
  status = execFileSync(
    "curl",
    [
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      "10",
      "--aws-sigv4",
      `aws:amz:${env.S3_REGION ?? "us-east-1"}:s3`,
      "--config",
      "-",
      "-X",
      "PUT",
      `${S3_ENDPOINT}/${S3_BUCKET}`,
    ],
    {
      encoding: "utf8",
      input: `user = "${S3_ACCESS_KEY_ID}:${S3_SECRET_ACCESS_KEY}"\n`,
      stdio: ["pipe", "pipe", "ignore"],
    },
  ).trim();
} catch {
  fail("storage is unreachable; run `pnpm run infra:up` and check `pnpm run infra:ps`");
}
// 409: the bucket already exists from an earlier run.
if (status !== "200" && status !== "409") fail(`create bucket answered status ${status}`);
console.log(`ok  bucket ${status === "200" ? "created" : "already exists"}`);
