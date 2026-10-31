// Live checks for with-test-stack.mjs, each read-only and loopback-only. A rejection carries no
// connection detail on purpose: the wrapper prints only which check failed.
//
// The PostgreSQL and S3 checks run in child processes whose whole environment is PROBE_ENV: no
// proxy (HTTP_PROXY, ALL_PROXY), libpq (PGHOST, PGOPTIONS, PGSSL*), AWS or curl setting of the
// parent can reroute them, and without HOME no ~/.curlrc, ~/.aws or ~/.pgpass is found. The
// endpoint and credentials always come from the verified files.

import { execFile } from "node:child_process";
import { connect } from "node:net";

export const PROBE_ENV = Object.freeze({ PATH: "/usr/bin:/bin" });
const TIMEOUT_MS = 5000;

/** Runs a program with PROBE_ENV and `input` on stdin; a timeout kills it. Resolves its stdout. */
export const runProbe = (file, args, input, timeout = TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { env: PROBE_ENV, timeout, killSignal: "SIGKILL", encoding: "utf8" },
      (error, stdout) => (error ? reject(new Error("probe failed")) : resolve(stdout)),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });

/** The database comment (the identity marker), or null when none is set. */
async function postgres(value, timeout) {
  const url = new URL(value);
  const settings = {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
  };
  const out = await runProbe(
    process.execPath,
    [new URL("./with-test-stack.pg-probe.mjs", import.meta.url).pathname],
    JSON.stringify(settings),
    timeout,
  );
  return JSON.parse(out);
}

const resp = (...parts) =>
  `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join("")}`;

/** AUTH then PING over plain RESP; any other reply (including NOAUTH, WRONGPASS) rejects. */
function redis(value) {
  const url = new URL(value);
  const auth = url.username ? [decodeURIComponent(url.username)] : [];
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) });
    let seen = "";
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error("timeout")));
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      seen += chunk;
      if (seen.startsWith("+OK\r\n+PONG\r\n")) {
        socket.end();
        resolve();
      } else if (seen.includes("-") && seen.includes("\r\n")) {
        socket.destroy();
        reject(new Error("refused"));
      }
    });
    socket.on("connect", () => {
      socket.write(resp("AUTH", ...auth, decodeURIComponent(url.password)) + resp("PING"));
    });
  });
}

// curl config strings treat backslash and double quote as special; the secret itself is unchanged.
export const quote = (value) =>
  value.replace(
    /[\\"\n\r\t\v]/g,
    (c) => ({ "\n": "\\n", "\r": "\\r", "\t": "\\t", "\v": "\\v" })[c] ?? `\\${c}`,
  );

/** Signed HEAD on the bucket, credentials on stdin (never in the process list). */
async function s3(env, timeout) {
  const out = await runProbe(
    "curl",
    [
      "-q", // first: no ~/.curlrc
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "-I",
      "--max-time",
      "5",
      "--noproxy",
      "*",
      "--aws-sigv4",
      `aws:amz:${env.S3_REGION}:s3`,
      "--config",
      "-",
      `${env.S3_ENDPOINT}/${env.S3_BUCKET}`,
    ],
    `user = "${quote(env.S3_ACCESS_KEY_ID)}:${quote(env.S3_SECRET_ACCESS_KEY)}"\n`,
    timeout,
  );
  if (out !== "200") throw new Error("refused");
}

export const createProbes = (timeout = TIMEOUT_MS) => ({
  postgres: (value) => postgres(value, timeout),
  redis,
  s3: (env) => s3(env, timeout),
});
export const probes = createProbes();
