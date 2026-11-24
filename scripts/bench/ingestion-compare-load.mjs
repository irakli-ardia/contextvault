// Offline loading and validation of ingestion benchmark results. It reads files only: no Docker,
// database or network. Every input yields an entry, valid or not, with the reasons it failed, so
// no evidence is dropped silently. A server-statistics problem is reported on its own and never
// fails the run, because the client-side timings stay valid. Which runs a comparison keeps, the
// stall threshold and every statistic are decisions of the comparison protocol, not made here.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SCHEMA_ARMS, STORED_TSV_DDL, verifyColumn } from "./ingestion-bench-schema.mjs";
import { scenarioMetrics } from "./ingestion-compare-metrics.mjs";
import {
  canonical,
  compareProvenance,
  isRecord,
  normalizeProvenance,
} from "./ingestion-compare-provenance.mjs";
import {
  broken,
  checkCli,
  checkContainers,
  checkEnvironment,
  checkTimes,
  matches,
} from "./ingestion-compare-records.mjs";
import {
  checkControls,
  checkServer,
  failure,
  serverScenario,
  shown,
} from "./ingestion-compare-server.mjs";

const text = (v) => typeof v === "string" && v !== "";

function checkIdentity(r) {
  return [
    ...broken([
      [!text(r.runId), "run-id", "missing runId"],
      [!text(r.experimentId), "experiment-id", "missing experimentId"],
    ]),
    ...checkTimes(r),
  ];
}

function checkRun(r) {
  const tree =
    r.workingTreeDirty === true ? "the working tree was dirty" : "working tree state is unknown";
  return broken([
    [r.benchmark !== "ingestion", "benchmark", `benchmark is ${shown(r.benchmark)}`],
    [r.status !== "complete", "status", `status is ${shown(r.status)}`],
    [r.cleanup?.verified !== true, "cleanup", "cleanup was not verified"],
    [!matches(/^[0-9a-f]{40}$/, r.gitSha), "git-sha", "gitSha is not a commit"],
    [r.workingTreeDirty !== false, "dirty-tree", tree],
    [!matches(/^[0-9a-f]{64}$/, r.diffSha256), "diff-hash", "diffSha256 missing"],
  ]);
}

function storedFailures(schema) {
  const out = [];
  try {
    verifyColumn(schema.column ?? null);
  } catch (error) {
    out.push(failure("schema-column", error.message));
  }
  const ddl = JSON.stringify(schema.ddl) === JSON.stringify(STORED_TSV_DDL.split("\n"));
  return [...out, ...broken([[!ddl, "schema-ddl", "recorded DDL is not the harness definition"]])];
}

function baselineFailures(schema) {
  return broken([
    [schema.column !== null, "schema-column", "baseline column is not recorded as null"],
    [!Array.isArray(schema.ddl) || schema.ddl.length > 0, "schema-ddl", "baseline DDL is not []"],
  ]);
}

function checkSchema(r) {
  const { schema } = r;
  if (!isRecord(schema))
    return [failure("legacy", "no schema metadata: evidence from before the schema arms")];
  if (!SCHEMA_ARMS.includes(schema.arm))
    return [failure("schema-arm", `unknown arm ${shown(schema.arm)}`)];
  const args = Array.isArray(r.cli?.arguments) ? r.cli.arguments : [];
  const given =
    args.find((a) => typeof a === "string" && a.startsWith("--schema="))?.slice(9) ?? "baseline";
  return [
    ...broken([
      [schema.arm !== given, "schema-arm", `arm ${shown(schema.arm)}, command line ${given}`],
      [schema.verified !== true, "schema-verified", "the arm was not verified"],
    ]),
    ...(schema.arm === "stored-tsv" ? storedFailures(schema) : baselineFailures(schema)),
  ];
}

function checkScenarios(r) {
  if (!Array.isArray(r.scenarios) || r.scenarios.length === 0)
    return [failure("scenarios", "no scenarios recorded")];
  return r.scenarios
    .filter((s) => s?.verification?.ok !== true)
    .map((s) => failure("scenario-verification", s?.name ?? "unnamed scenario"));
}

/** Validates one parsed result. Never throws on a well-formed JSON value. */
export function validateResult(result) {
  if (!isRecord(result))
    return { failures: [failure("structure", "result is not an object")], identity: null };
  const control = checkControls(result);
  const failures = [
    ...checkIdentity(result),
    ...checkRun(result),
    ...checkCli(result),
    ...checkEnvironment(result),
    ...checkContainers(result),
    ...checkSchema(result),
    ...checkScenarios(result),
    ...control.failures,
  ];
  const identity = {
    runId: result.runId ?? null,
    experimentId: result.experimentId ?? null,
    startedAt: result.startedAt ?? null,
    completedAt: result.completedAt ?? null,
    arm: result.schema?.arm ?? null,
    gitSha: result.gitSha ?? null,
  };
  const server = checkServer(result);
  return {
    failures,
    identity,
    server,
    metrics: Array.isArray(result.scenarios)
      ? result.scenarios
          .filter(isRecord)
          .map((s) => scenarioMetrics(s, server.enabled ? serverScenario(s) : undefined))
      : [],
    controls: control.controls,
    provenance: normalizeProvenance(result),
  };
}

/**
 * One file's bytes as an entry: checksum of the raw bytes first, then parse, then validation.
 * Messages are fixed text: a parser error would quote the input.
 */
export function loadText(file, bytes) {
  const base = { file: basename(file), sha256: createHash("sha256").update(bytes).digest("hex") };
  const rejected = (code, detail) => ({
    ...base,
    valid: false,
    failures: [failure(code, detail)],
    identity: null,
  });
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return rejected("malformed-json", "the file is not valid JSON");
  }
  try {
    const checked = validateResult(parsed);
    // Every provenance comparison later canonicalizes this; a value that cannot be is rejected here.
    if (checked.provenance) canonical(checked.provenance);
    return { ...base, valid: checked.failures.length === 0, ...checked };
  } catch {
    return rejected("structure", "the JSON value has an unexpected structure");
  }
}

const unreadable = (file, code, detail) => ({
  file: basename(file),
  sha256: null,
  valid: false,
  failures: [failure(code, detail)],
  identity: null,
});

/** Reads only regular files: a symlink, FIFO, device or directory is refused before any read. */
export function loadFile(path, read = readFileSync, stat = lstatSync) {
  let info;
  try {
    info = stat(path);
  } catch (error) {
    return unreadable(path, "unreadable", error.code ?? "stat failed");
  }
  if (!info.isFile())
    return unreadable(
      path,
      "unsupported-file-type",
      info.isSymbolicLink() ? "symlink" : "not a regular file",
    );
  try {
    return loadText(path, read(path));
  } catch (error) {
    return unreadable(path, "unreadable", error.code ?? "read failed");
  }
}

const duplicates = (entries, key) => {
  const seen = Map.groupBy(
    entries.filter((e) => e.identity?.[key]),
    (e) => e.identity[key],
  );
  return [...seen]
    .filter(([, list]) => list.length > 1)
    .map(([id, list]) => ({
      code: `duplicate-${key}`,
      detail: `${id}: ${list.map((e) => e.file).join(", ")}`,
    }));
};

/**
 * Loads every `*.json` file of a directory (sorted by name) and compares the provenance of the
 * valid runs. `errors` holds problems of the set itself; invalid runs stay in `entries`.
 */
export function loadDirectory(
  dir,
  io = { list: readdirSync, read: readFileSync, stat: lstatSync },
) {
  let names;
  try {
    names = io
      .list(dir)
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch (error) {
    return { entries: [], errors: [failure("directory-unreadable", error.code ?? "list failed")] };
  }
  const entries = names.map((n) => loadFile(join(dir, n), io.read, io.stat));
  const errors = [
    ...(names.length === 0 ? [failure("no-json-files", "the directory holds no .json file")] : []),
    ...duplicates(entries, "runId"),
    ...duplicates(entries, "experimentId"),
  ];
  const usable = entries
    .filter((e) => e.valid)
    .map((e) => ({ file: e.file, provenance: e.provenance }));
  return { entries, errors, provenance: compareProvenance(usable) };
}
