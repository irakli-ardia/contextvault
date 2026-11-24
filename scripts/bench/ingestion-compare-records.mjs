// Checks of the recorded facts a comparison relies on: timestamps, command line, host and
// containers. Each field below is one the harness always records (`ingestion-bench.mjs`,
// `ingestion-bench-provenance.mjs`); a missing or malformed one fails closed, because provenance
// that is equally absent in every run would otherwise compare as "identical".

import { parseArgs } from "./ingestion-bench-args.mjs";
import { isRecord } from "./ingestion-compare-provenance.mjs";
import { failure } from "./ingestion-compare-server.mjs";

const text = (v) => typeof v === "string" && v !== "";
/** Only a real string can match: a regex test would coerce `["abc"]` to `"abc"`. */
export const matches = (re, v) => typeof v === "string" && re.test(v);
const positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** `[broken, code, detail]` rows to the failures of the rows that are broken. */
export const broken = (rows) =>
  rows.filter(([bad]) => bad).map(([, code, detail]) => failure(code, detail));

/** The harness writes `toISOString()`: UTC, milliseconds, a real calendar date. */
export function parseTime(v) {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) || new Date(ms).toISOString() !== v ? null : ms;
}

export function checkTimes(r) {
  const start = parseTime(r.startedAt);
  const end = parseTime(r.completedAt);
  const needsEnd = r.status === "complete" || r.completedAt !== undefined;
  return broken([
    [start === null, "timestamp", "startedAt is not an ISO UTC time"],
    [needsEnd && end === null, "timestamp", "completedAt is not an ISO UTC time"],
    [start !== null && end !== null && end < start, "timestamp", "completedAt is before startedAt"],
  ]);
}

/** The command line as the harness would parse it, and the recorded configuration it produced. */
export function checkCli(r) {
  const args = r.cli?.arguments;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string"))
    return [failure("cli-arguments", "cli.arguments is not a list of strings")];
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch {
    return [failure("cli-arguments", "the command line is not one the harness accepts")];
  }
  const config = isRecord(r.config) ? r.config : {};
  return broken([
    [r.cli.command !== "run" || parsed.command !== "run", "cli-command", "not a run command"],
    [parsed.execute !== true, "cli-command", "the run was not executed"],
    [parsed.repeats !== config.repeats, "cli-config", "repeats differ from the command line"],
    [parsed.rounds !== config.rounds, "cli-config", "rounds differ from the command line"],
    [parsed.smoke !== config.smoke, "cli-config", "smoke differs from the command line"],
    [
      parsed.serverStats !== (config.serverStats === true),
      "cli-config",
      "server statistics differ from the command line",
    ],
  ]);
}

export function checkEnvironment(r) {
  const e = r.environment;
  const complete =
    isRecord(e) &&
    ["postgres", "pgvector", "node", "cpu", "platform"].every((k) => text(e[k])) &&
    positive(e.memoryGb) &&
    isRecord(e.settings);
  return broken([[!complete, "environment", "environment record missing or incomplete"]]);
}

function containerFailures(name, c) {
  if (!isRecord(c)) return [failure("container", `${name} container facts missing`)];
  const limits = ["memoryLimitBytes", "cpuLimit", "pidsLimit"].every((k) => positive(c[k]));
  return broken([
    [!text(c.image), "container", `${name} image missing`],
    [!matches(/^sha256:[0-9a-f]{64}$/, c.imageId), "container", `${name} imageId is not a digest`],
    [!limits, "container", `${name} resource limits missing or invalid`],
  ]);
}

export function checkContainers(r) {
  const c = isRecord(r.containers) ? r.containers : {};
  return [...containerFailures("postgres", c.postgres), ...containerFailures("redis", c.redis)];
}
