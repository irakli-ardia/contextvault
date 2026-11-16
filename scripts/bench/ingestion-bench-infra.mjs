// The ingestion benchmark's containers. Both carry this harness's own kind label, a name pattern
// and the run id of this invocation, so that start-up, identity checks and removal can never
// reach the keyword experiment, the development stack, cv-test or another invocation's containers.
// PostgreSQL reuses the keyword container functions through INGESTION; Redis gets the same rules:
// pinned image, loopback-only random port, no host mounts, removed with its anonymous volume.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = new URL("../../", import.meta.url).pathname;
const KIND = "ingestion-bench";
export const INGESTION = { kind: KIND, name: "cv-ingbench-pg", database: "cv_ingbench" };
export const REDIS_LABEL = `cv.experiment=${KIND}`;
const REDIS_NAME = /^cv-ingbench-redis-[0-9a-f]{8}$/;
const MARKER_KEY = "cv:bench:marker";

export const newRunId = () => randomBytes(4).toString("hex");

export function redisSpec({
  id = newRunId(),
  compose = readFileSync(join(root, "infra/compose.yaml"), "utf8"),
} = {}) {
  const image = /image:\s*(redis:\S+@sha256:[0-9a-f]{64})/.exec(compose)?.[1];
  if (!image) throw new Error("no pinned redis image in infra/compose.yaml");
  const name = `cv-ingbench-redis-${id}`;
  const args = [
    ...["run", "-d", "--rm", "--pull=never", "--name", name, "--label", REDIS_LABEL],
    ...["--label", `cv.experiment.run=${id}`],
    ...["--memory", "1g", "--cpus", "1", "--pids-limit", "256"],
    ...["--security-opt", "no-new-privileges", "--publish", "127.0.0.1::6379"],
    // No snapshots or append file: nothing of the queue outlives the container.
    ...[image, "redis-server", "--save", "", "--appendonly", "no"],
  ];
  return { id, name, image, args };
}

const refuse = (what) => {
  throw new Error(`redis container refused: ${what}`);
};

/** The loopback port, or a refusal for anything but one loopback port and anonymous storage. */
export function assertRedisSafe(inspect, spec) {
  if (inspect.Name !== `/${spec.name}` || !REDIS_NAME.test(spec.name)) refuse("name");
  if (inspect.Config.Image !== spec.image) refuse("image");
  const labels = inspect.Config.Labels ?? {};
  if (labels["cv.experiment"] !== KIND || labels["cv.experiment.run"] !== spec.id) refuse("label");
  if (inspect.HostConfig.Privileged) refuse("privileges");
  if (!["bridge", "default"].includes(inspect.HostConfig.NetworkMode)) refuse("network");
  if (inspect.Mounts.some((m) => m.Type !== "volume")) refuse("host mounts");
  const bound = Object.entries(inspect.NetworkSettings.Ports ?? {});
  const published = bound.flatMap(([, list]) => list ?? []);
  if (bound.length !== 1 || bound[0][0] !== "6379/tcp" || published.length !== 1) refuse("ports");
  const [{ HostIp: ip, HostPort: port }] = published;
  if (ip !== "127.0.0.1" || !/^\d+$/.test(port) || port === "6379") refuse("published endpoint");
  return Number(port);
}

/** Names of this harness's Redis containers; the label is shared with PostgreSQL, so the name decides. */
/** Fails closed: a Docker error is never read as "no containers". */
const redisNames = (docker) => {
  const listed = docker(["ps", "-a", "--filter", `label=${REDIS_LABEL}`, "--format", "{{.Names}}"]);
  if (listed.status !== 0) {
    throw new Error(`docker ps (redis) failed: ${listed.stderr.trim().slice(0, 200)}`);
  }
  return listed.stdout.split("\n").filter((n) => REDIS_NAME.test(n));
};

/** Starts Redis, plants this run's marker in it from inside the container, and returns its facts. */
export async function startRedis(docker, spec, marker) {
  if (redisNames(docker).length > 0)
    throw new Error("an ingestion redis container already exists: run the cleanup command first");
  const run = docker(spec.args);
  if (run.status !== 0) throw new Error(`docker run (redis) failed: ${run.stderr.slice(0, 200)}`);
  for (let i = 0; i < 30; i += 1) {
    if (docker(["exec", spec.name, "redis-cli", "ping"]).stdout.trim() === "PONG") break;
    if (i === 29) throw new Error("redis did not become ready");
    await sleep(500);
  }
  const inspect = JSON.parse(docker(["inspect", "--type", "container", spec.name]).stdout)[0];
  const port = assertRedisSafe(inspect, spec);
  const set = docker(["exec", spec.name, "redis-cli", "set", MARKER_KEY, marker]);
  if (set.status !== 0) throw new Error("redis marker could not be planted");
  return { port, inspect };
}

/** The connected Redis must be the one this run planted its marker in, and hold nothing else. */
export async function assertRedisIdentity(client, marker) {
  if ((await client.get(MARKER_KEY)) !== marker) throw new Error("redis identity marker mismatch");
  if ((await client.dbsize()) !== 1) throw new Error("redis holds keys this run did not create");
}

const GONE = /no such (object|container)/i;

const labelsOf = (stdout) => {
  try {
    return JSON.parse(stdout)[0]?.Config?.Labels ?? {};
  } catch {
    return {};
  }
};

/**
 * Removes a container only if it is this run's: the name pattern must match and, when it exists,
 * its kind and run labels must name this invocation. Then proves it is gone.
 */
export function removeOwned(docker, { name, id, pattern, kind }) {
  if (!pattern.test(name))
    throw new Error("refusing to remove a container this harness did not name");
  const seen = docker(["inspect", "--type", "container", name]);
  if (seen.status !== 0) {
    return GONE.test(seen.stderr)
      ? { removed: true }
      : { removed: false, detail: `inspect: ${seen.stderr.trim().slice(0, 200)}` };
  }
  const labels = labelsOf(seen.stdout);
  if (labels["cv.experiment"] !== kind || labels["cv.experiment.run"] !== id) {
    return { removed: false, detail: "not this run's container: left untouched" };
  }
  const removal = docker(["rm", "-f", "-v", name]);
  const check = docker(["inspect", "--type", "container", name]);
  if (check.status !== 0 && GONE.test(check.stderr)) return { removed: true };
  return { removed: false, detail: `still present; rm: ${removal.stderr.trim().slice(0, 200)}` };
}

export const removeRedis = (docker, spec) =>
  removeOwned(docker, { name: spec.name, id: spec.id, pattern: REDIS_NAME, kind: KIND });

export const removePostgres = (docker, spec) =>
  removeOwned(docker, {
    name: spec.name,
    id: spec.id,
    pattern: new RegExp(`^${INGESTION.name}-[0-9a-f]{8}$`),
    kind: KIND,
  });

export const removeRedisLeftovers = (docker) =>
  redisNames(docker).map((name) => {
    docker(["rm", "-f", "-v", name]);
    const gone = GONE.test(docker(["inspect", "--type", "container", name]).stderr);
    return { name, removed: gone };
  });

/**
 * Builds the benchmark bundle and the real worker build (parser child included) into one
 * directory under apps/worker/dist, where bullmq and pg resolve. The caller removes `dir`.
 */
export function buildBundles(id, run = spawnSync) {
  const dir = join(root, "apps/worker/dist", `ingestion-bench-${id}`);
  mkdirSync(dir, { recursive: true });
  const worker = join(root, "apps/worker");
  const bundle = run(
    join(worker, "node_modules/.bin/tsdown"),
    [
      "-c",
      join(root, "scripts/bench/ingestion-bench.tsdown.config.mjs"),
      "-d",
      join(dir, "bundle"),
      "-l",
      "warn",
    ],
    { cwd: worker, encoding: "utf8" },
  );
  const child = run(
    process.execPath,
    [join(worker, "node_modules/tsdown/dist/run.mjs"), "--out-dir", join(dir, "worker")],
    { cwd: worker, encoding: "utf8" },
  );
  const failed = bundle.status !== 0 ? bundle : child;
  if (failed.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    const what = failed === bundle ? "bundle" : "worker build";
    throw new Error(`${what} failed: ${(failed.stderr || "no output").slice(0, 300)}`);
  }
  return {
    dir,
    entry: join(dir, "bundle/ingestion-bench.entry.mjs"),
    parseChild: join(dir, "worker/parse-child.mjs"),
  };
}
