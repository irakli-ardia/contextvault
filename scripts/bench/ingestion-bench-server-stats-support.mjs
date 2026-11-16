// Doubles shared by the server-statistics tests: the ingestion benchmark's own container spec, the
// inspect record `docker inspect` would give for it, and a docker function that answers by SQL text.
import { INGESTION } from "./ingestion-bench-infra.mjs";
import {
  SERVER_ARGS,
  SERVER_SETTINGS,
  SQL,
  startServerStats,
} from "./ingestion-bench-server-stats.mjs";
import { containerSpec } from "./keyword-experiment-container.mjs";

export const spec = containerSpec({ profile: INGESTION, id: "0a1b2c3d", serverArgs: SERVER_ARGS });
export const ID = "a".repeat(64);
export const accepted = { Id: ID, Image: "sha256:image" };
export const inspected = (patch = {}) => ({
  ...accepted,
  Name: `/${spec.name}`,
  State: { Running: true },
  Config: {
    Image: spec.image,
    Labels: { "cv.experiment": "ingestion-bench", "cv.experiment.run": spec.id },
    Env: [`POSTGRES_DB=${spec.database}`],
  },
  HostConfig: { Privileged: false, NetworkMode: "bridge" },
  NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55123" }] } },
  Mounts: [
    { Type: "volume", Destination: "/var/lib/postgresql", RW: true },
    ...spec.binds.map((b) => ({
      Type: "bind",
      Source: b.source,
      Destination: b.target,
      RW: false,
    })),
  ],
  ...patch,
});

export const roles = (over = {}) =>
  ["contextvault_app", "contextvault_fixture", "contextvault_owner", "contextvault_worker"].map(
    (role) => ({
      role,
      super: false,
      bypassRls: false,
      schemaUsage: false,
      canReset: false,
      ...over[role],
    }),
  );
export const facts = (over = {}) => ({
  superuser: true,
  settings: SERVER_SETTINGS,
  extensionSchema: "bench_stats",
  roles: roles(),
  ...over,
});
export const read = { info: { dealloc: 0, statsReset: "t" }, rows: [] };

/** A docker double: records every call, answers inspect, psql (by SQL text) and logs. */
export function fakeDocker({ inspect = inspected, marker = "m1", answers = {}, fail } = {}) {
  const calls = [];
  const docker = (args, opts = {}) => {
    calls.push({ args, input: opts.input });
    if (args[0] === "inspect")
      return { status: 0, stdout: JSON.stringify([inspect()]), stderr: "" };
    if (args[0] === "logs") return { status: 0, stdout: "", stderr: answers.logs ?? "" };
    if (opts.input === fail) return { status: 1, stdout: "", stderr: "ERROR: nope" };
    const table = {
      [SQL.marker]: { database: spec.database, marker },
      [SQL.verify]: facts(),
      [SQL.read]: read,
      ...answers,
    };
    const out = table[opts.input];
    // A string is the raw psql output; anything else is a document.
    const text = typeof out === "string" ? out : JSON.stringify(out);
    return { status: 0, stdout: out === undefined ? "" : text, stderr: "" };
  };
  return { docker, calls };
}
export const start = (docker, over = {}) =>
  startServerStats({ docker, spec, accepted, marker: "m1", ...over });
export const psqlInputs = (calls) => calls.filter((c) => c.args[0] === "exec").map((c) => c.input);
