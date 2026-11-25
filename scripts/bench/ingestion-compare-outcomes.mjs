// Fail-closed classification of what an ingestion result records about failures. It reads only
// fields the harness writes (`ingestion-bench-run.mjs` scenarios, `ingestion-bench.mjs` run state,
// the consumer's `INGESTION_JOB_*` log codes) and describes evidence; whether a run may be
// excluded, compared or accepted is a protocol decision made elsewhere.
//
// Standing: `invalid` if any reason is `correctness` (a defect the record proves) or `unresolved`
// (missing, truncated, ambiguous or unattributable evidence); else `outcome` if only `performance`
// reasons exist; else `valid`. Nothing is inferred and no reason is dropped.
//
// What the record cannot say: a job event carries no job or version id, a statement error carries
// no version, a redelivery drops its cause, and SQLSTATE 57014 is kept as a code only (a statement
// timeout cannot be told from another cancellation). A retry, redelivery, worker error, cancelled
// statement or unfinished version is therefore `unresolved`, never `performance`: in the worker a
// transient database error surfaces as `DONE retry stage.unexpected` (after the claim) or a
// redelivery (before it), and the harness re-runs neither. `outcome` is thus reachable only for a
// transient lock or serialization statement error (40001, 40P01, 55P03) that leaves every job
// event, version row and count consistent, which the worker's own handling is not expected to
// produce. A rollback is not matched to a statement: one such error accounts for at most one.
// `count` is how often a recorded item occurred (events, statements, problems), never distinct jobs.

import { get, num, str } from "./ingestion-compare-metrics.mjs";
import { jobEvents, label, OVERSIZE } from "./ingestion-compare-outcomes-events.mjs";
import { isRecord } from "./ingestion-compare-provenance.mjs";

/** Lock/serialization conflicts the worker treats as transient, minus 57014 (see `cancelled`). */
const TRANSIENT_SQLSTATE = new Set(["40001", "40P01", "55P03"]);
const CANCELLED = "57014";
const RUN_STATUS = new Map([
  ["interrupted", "run-interrupted"],
  ["failed", "run-failed"],
  ["invalid", "run-invalid"],
]);
/**
 * The harness's own fixed `verifyCounts` reasons. A version that is not `ready` is `unresolved`:
 * a retry, redelivery or failed job leaves it that way and nothing ties the two together.
 */
const PROBLEMS = [
  [/^version missing$/, "version-missing", "correctness"],
  [/^rejected document was activated$/, "rejected-activated", "correctness"],
  [/^status \S/, "status-not-ready", "unresolved"],
  [/^chunks \d+, expected \d+$/, "chunk-count-mismatch", "correctness"],
  [/^embeddings \d+, chunks \d+$/, "embedding-count-mismatch", "correctness"],
];

function collector(scope) {
  const seen = new Map();
  const add = (kind, code, detail = null, count = 1) => {
    const key = `${kind}\0${code}\0${detail}`;
    const hit = seen.get(key);
    if (hit) hit.count += count;
    else seen.set(key, { kind, code, scope, detail, count });
  };
  return { add, all: () => [...seen.values()] };
}

function statementErrors(s, add) {
  const errors = get(s, "statementErrors");
  if (!Array.isArray(errors)) return add("unresolved", "statement-errors-missing");
  for (const e of errors) {
    const code = str(get(e, "code"));
    const detail = `${label(get(e, "label"))}:${label(code)}`;
    if (code === CANCELLED) add("unresolved", "statement-cancelled-unattributed", detail);
    else if (TRANSIENT_SQLSTATE.has(code)) add("performance", "statement-error", detail);
    else add("unresolved", "statement-error-unclassified", detail);
  }
  return errors.filter((e) => TRANSIENT_SQLSTATE.has(str(get(e, "code")))).length;
}

function transactions(s, add, explained) {
  const t = get(s, "transactionOutcomes");
  const count = (k) => (get(t, k) === undefined ? 0 : num(get(t, k)));
  const [rollback, error] = [count("rollback"), count("error")];
  if (!isRecord(t) || rollback === null || error === null)
    return add("unresolved", "transactions-missing");
  if (error > 0) add("unresolved", "transaction-error", null, error);
  if (rollback > explained) add("unresolved", "rollback-unexplained", null, rollback - explained);
  activationTransactions(s, add, rollback);
}

/** A rolled-back activation attempt also carries chunk inserts, so it may exceed `completed`. */
function activationTransactions(s, add, rollback) {
  const [done, found] = [num(get(s, "completed")), num(get(s, "activationTransactions"))];
  if (done === null || found === null || found < done || found > done + rollback)
    add("unresolved", "activation-transactions-mismatch");
}

function verification(s, add) {
  const v = get(s, "verification");
  if (!isRecord(v) || typeof get(v, "ok") !== "boolean")
    return add("unresolved", "verification-missing");
  const [jobs, mismatched] = [num(get(s, "jobs")), num(get(v, "mismatchedVersions"))];
  if (jobs === null || num(get(v, "checked")) !== jobs)
    add("unresolved", "verification-incomplete");
  if (v.ok) {
    if (mismatched !== 0) add("unresolved", "verification-contradiction");
    return;
  }
  problemList(get(v, "problems"), mismatched, add);
}

const problemOf = (reason) => {
  const known = reason === null ? undefined : PROBLEMS.find(([re]) => re.test(reason));
  return known ? [known[1], known[2]] : ["verification-unrecognized", "correctness"];
};

function problemList(problems, mismatched, add) {
  const listed = Array.isArray(problems) ? problems : [];
  if (mismatched === null || listed.length === 0 || listed.length < mismatched)
    add("unresolved", "verification-truncated");
  for (const p of listed) {
    const [code, kind] = problemOf(str(get(p, "reason")));
    add(kind, code);
  }
}

/** Only the plan's oversize document, rejected once at parsing, may end a version unfinished. */
const isExpectedRejection = (r, rejection) =>
  rejection &&
  str(get(r, "status")) === "failed" &&
  num(get(r, "attempt")) === 1 &&
  get(r, "error_stage") === OVERSIZE.stage &&
  get(r, "error_code") === OVERSIZE.failure;

function versionRow(r, add, rejection) {
  const [n, status] = [num(get(r, "versions")), str(get(r, "status"))];
  if (n === null || status === null) {
    add("unresolved", "statuses-malformed");
    return null;
  }
  if (status === "ready") {
    if (num(get(r, "attempt")) !== 1) add("unresolved", "version-reattempted", null, n);
    return { ready: n, other: 0 };
  }
  if (!isExpectedRejection(r, rejection))
    add("unresolved", "version-not-ready", `${label(status)}:${label(get(r, "error_code"))}`);
  return { ready: 0, other: n };
}

/** Version rows against the activations and terminal events the scenario recorded. */
function versions(s, add, failed, rejection) {
  const rows = get(get(s, "verification"), "statuses");
  if (!Array.isArray(rows)) return add("unresolved", "statuses-missing");
  const parts = rows.map((r) => versionRow(r, add, rejection)).filter((p) => p !== null);
  const ready = parts.reduce((a, p) => a + p.ready, 0);
  const other = parts.reduce((a, p) => a + p.other, 0);
  const [jobs, done] = [num(get(s, "jobs")), num(get(s, "completed"))];
  if (jobs === null || ready !== done || ready + other !== jobs || other !== failed)
    add("unresolved", "activation-mismatch");
}

/** The expected rejection is one document that never reached an activation transaction. */
function rejectionEvidence(s, add) {
  const [jobs, done] = [num(get(s, "jobs")), num(get(s, "completed"))];
  if (jobs !== 1 || done !== 0 || num(get(s, "activationTransactions")) !== 0)
    add("unresolved", "rejection-evidence-mismatch");
}

function scenarioReasons(s, scope) {
  const { add, all } = collector(scope);
  if (!isRecord(s)) {
    add("unresolved", "scenario-malformed");
    return all();
  }
  const rejection = str(get(s, "name")) === OVERSIZE.scenario;
  const explained = statementErrors(s, add);
  transactions(s, add, explained);
  const { processed, failed } = jobEvents(s, add, rejection);
  const [jobs, done] = [num(get(s, "jobs")), num(get(s, "completed"))];
  if (processed !== done || processed + failed !== jobs)
    add("unresolved", "job-accounting-mismatch");
  verification(s, add);
  versions(s, add, failed, rejection);
  if (rejection) rejectionEvidence(s, add);
  return all();
}

function runReasons(result) {
  const { add, all } = collector("run");
  const status = str(get(result, "status"));
  if (status !== "complete")
    add("unresolved", RUN_STATUS.get(status) ?? "run-incomplete", label(status));
  if (get(get(result, "cleanup"), "verified") !== true) add("unresolved", "cleanup-unverified");
  if (get(get(result, "schema"), "verified") !== true) add("unresolved", "schema-unverified");
  if (!Array.isArray(get(result, "scenarios")) || result.scenarios.length === 0)
    add("unresolved", "scenarios-missing");
  return all();
}

/**
 * `{ standing, reasons }` for one entry: `failures` as `validateResult` reported them and the
 * parsed `result` (absent when the file could not be parsed). Every loader failure is itself an
 * `unresolved` reason, so an entry the loader refused can never be `valid` or `outcome`.
 * Total over any input; never mutates it.
 */
export function standingOf(input) {
  const [failures, result] = [get(input, "failures"), get(input, "result")];
  const loader = collector("run");
  const list = Array.isArray(failures) ? failures : [];
  for (const f of list) loader.add("unresolved", "loader-failure", label(get(f, "code")));
  const evidence = isRecord(result) && Array.isArray(failures);
  if (!evidence) loader.add("unresolved", "evidence-missing");
  const scenarios = evidence && Array.isArray(result.scenarios) ? result.scenarios : [];
  const reasons = [
    ...loader.all(),
    ...(evidence ? runReasons(result) : []),
    ...scenarios.flatMap((s, i) => scenarioReasons(s, label(get(s, "name") ?? `#${i}`))),
  ];
  if (reasons.some((r) => r.kind !== "performance")) return { standing: "invalid", reasons };
  return { standing: reasons.length > 0 ? "outcome" : "valid", reasons };
}
