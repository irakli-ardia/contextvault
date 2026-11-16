// A disposable PostgreSQL container for the keyword-search experiment. Everything that decides
// what the container is allowed to be lives here as pure functions, so tests can pin it without
// Docker: the `docker` function is injected, every secret is generated per run and travels only as
// an inherited environment variable (the argument list names variables, never values), and the
// container is accepted only after `docker inspect` shows loopback-only publishing, no host
// storage and nothing but the three read-only role scripts bind-mounted.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = new URL("../../", import.meta.url).pathname;
/** What names a harness's containers: another benchmark passes its own, so none can touch another's. */
export const KEYWORD = { kind: "keyword-search", name: "cv-kwexp", database: "cv_kwexp" };
const nameOf = (profile) => new RegExp(`^${profile.name}-[0-9a-f]{8}$`);
const labelOf = (profile) => `cv.experiment=${profile.kind}`;
const SECRETS = [
  "POSTGRES_PASSWORD",
  "POSTGRES_APP_PASSWORD",
  "POSTGRES_WORKER_PASSWORD",
  "POSTGRES_OWNER_PASSWORD",
  "POSTGRES_FIXTURE_PASSWORD",
];
// The same three scripts, in the same order, that the development compose file mounts.
const INIT = [
  ["init.sql", "10-init.sql"],
  ["init-roles.sh", "20-init-roles.sh"],
  ["roles.sql", "30-roles.sql"],
];

// biome-ignore lint/style/noProcessEnv: the docker client needs HOME and PATH; DOCKER_* is checked
export const dockerEnvironment = () => process.env;

/** The only way out of this module; secrets reach `docker` as inherited variables, not arguments. */
export function dockerCli(args, { env = {}, input } = {}) {
  const run = spawnSync("docker", args, {
    encoding: "utf8",
    input,
    env: { ...dockerEnvironment(), ...env },
  });
  return {
    status: run.status,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? run.error?.message ?? "",
  };
}

/** The image the development stack pins, so the experiment runs the server the product runs on. */
export function pinnedImage(composeText) {
  const image = /image:\s*(pgvector\/pgvector:\S+@sha256:[0-9a-f]{64})/.exec(composeText)?.[1];
  if (!image) throw new Error("no pinned pgvector image in infra/compose.yaml");
  return image;
}

export function containerSpec({
  profile = KEYWORD,
  id = randomBytes(4).toString("hex"),
  image = pinnedImage(readFileSync(join(root, "infra/compose.yaml"), "utf8")),
  secret = () => randomBytes(18).toString("hex"),
  serverArgs = [],
} = {}) {
  const name = `${profile.name}-${id}`;
  const database = `${profile.database}_${id}`;
  const binds = INIT.map(([from, to]) => ({
    source: join(root, "infra/postgres", from),
    target: `/docker-entrypoint-initdb.d/${to}`,
  }));
  const args = [
    ...[
      "run",
      "-d",
      "--rm",
      "--pull=never",
      "--name",
      name,
      "--label",
      labelOf(profile),
      "--label",
      `cv.experiment.run=${id}`,
    ],
    ...["--memory", "4g", "--cpus", "2", "--pids-limit", "512", "--shm-size", "256m"],
    ...["--security-opt", "no-new-privileges", "--publish", "127.0.0.1::5432"],
    // An anonymous volume: private to this container and removed with it (`rm -v`).
    ...["--volume", "/var/lib/postgresql"],
    ...binds.flatMap((b) => ["--volume", `${b.source}:${b.target}:ro`]),
    ...["--env", "POSTGRES_USER=postgres", "--env", `POSTGRES_DB=${database}`],
    ...SECRETS.flatMap((variable) => ["--env", variable]),
    image,
    // Server arguments follow the image; empty (the default) leaves the argument list unchanged.
    ...serverArgs,
  ];
  const secrets = Object.fromEntries(SECRETS.map((variable) => [variable, secret()]));
  return { id, name, database, image, binds, secrets, args, profile };
}

const refuse = (what) => {
  throw new Error(`container refused: ${what}`);
};

/** Returns the published loopback port, or throws on anything the experiment must not touch. */
// fallow-ignore-next-line complexity
export function assertContainerSafe(inspect, spec) {
  const { Config: config, HostConfig: host, Mounts: mounts, NetworkSettings: net } = inspect;
  if (inspect.Name !== `/${spec.name}` || !nameOf(spec.profile).test(spec.name)) refuse("name");
  if (config.Image !== spec.image) refuse("image");
  if (config.Labels?.["cv.experiment"] !== spec.profile.kind) refuse("label");
  if (config.Labels?.["cv.experiment.run"] !== spec.id) refuse("run label");
  if (!config.Env.includes(`POSTGRES_DB=${spec.database}`)) refuse("database name");
  if (host.Privileged || !["bridge", "default"].includes(host.NetworkMode)) refuse("privileges");
  const ports = Object.entries(net.Ports ?? {});
  const bound = ports.flatMap(([, list]) => list ?? []);
  if (ports.length !== 1 || ports[0][0] !== "5432/tcp" || bound.length !== 1) refuse("ports");
  const [{ HostIp: ip, HostPort: port }] = bound;
  if (ip !== "127.0.0.1" || !/^\d+$/.test(port) || port === "5432") refuse("published endpoint");
  const volumes = mounts.filter((m) => m.Type === "volume");
  const binds = mounts.filter((m) => m.Type === "bind");
  if (mounts.length !== volumes.length + binds.length) refuse("mount type");
  if (volumes.length !== 1 || volumes[0].Destination !== "/var/lib/postgresql") refuse("storage");
  const expected = spec.binds.map((b) => `${b.source}>${b.target}`).sort();
  const actual = binds.map((m) => (m.RW ? "rw" : `${m.Source}>${m.Destination}`)).sort();
  if (expected.join() !== actual.join()) refuse("bind mounts");
  return Number(port);
}

/** `.sql` files of the migration folder in application order, as one script. */
export function migrationSql(dir = join(root, "infra/migrations")) {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  if (files.length === 0) throw new Error("no migrations found");
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

const ok = (result, what) => {
  if (result.status !== 0) throw new Error(`${what} failed: ${result.stderr.trim().slice(0, 300)}`);
  return result.stdout.trim();
};

export function startContainer(docker, spec) {
  if (ok(docker(["ps", "-aq", "--filter", `label=${labelOf(spec.profile)}`]), "list").length > 0) {
    throw new Error("an experiment container already exists: run the cleanup command first");
  }
  ok(docker(spec.args, { env: spec.secrets }), "docker run");
}

export async function waitReady(docker, spec, attempts = 90) {
  for (let i = 0; i < attempts; i += 1) {
    const probe = docker(["exec", spec.name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
    if (probe.status === 0) return;
    await sleep(1000);
  }
  throw new Error("postgres did not become ready");
}

export const inspectContainer = (docker, spec) =>
  JSON.parse(ok(docker(["inspect", "--type", "container", spec.name]), "inspect"))[0];

/** One psql run over a local socket inside the container; SQL arrives on stdin. */
export function psql(docker, spec, user, sql) {
  const args = ["exec", "-i", spec.name, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-1"];
  return ok(docker([...args, "-U", user, "-d", spec.database], { input: sql }), "psql");
}

/**
 * Removes the container, then proves it is gone: only "No such container" counts. A daemon that
 * cannot be reached, or a container that is still there, is reported as not removed.
 */
export function removeContainer(docker, name, profile = KEYWORD) {
  if (!nameOf(profile).test(name))
    throw new Error("refusing to remove a container this harness did not name");
  const removal = docker(["rm", "-f", "-v", name]);
  const check = docker(["inspect", "--type", "container", name]);
  if (check.status !== 0 && /no such (object|container)/i.test(check.stderr)) {
    return { removed: true };
  }
  const detail =
    check.status === 0 ? "still present" : `inspect: ${check.stderr.trim().slice(0, 200)}`;
  return { removed: false, detail: `${detail}; rm: ${removal.stderr.trim().slice(0, 200)}` };
}

/** Removes only containers that carry the experiment label and the harness's name pattern. */
export function removeLeftovers(docker, profile = KEYWORD) {
  const listed = ok(
    docker(["ps", "-a", "--filter", `label=${labelOf(profile)}`, "--format", "{{.Names}}"]),
    "list",
  );
  const results = listed
    .split("\n")
    .filter((n) => nameOf(profile).test(n))
    .map((name) => ({ name, ...removeContainer(docker, name, profile) }));
  return {
    removed: results.filter((r) => r.removed).map((r) => r.name),
    failed: results.filter((r) => !r.removed),
  };
}
