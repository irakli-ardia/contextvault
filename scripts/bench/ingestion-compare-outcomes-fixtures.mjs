// Harness-shaped inputs for the outcome classification tests. Scenarios start from the shared
// `fullScenario` (every field the harness records). Each state below is one the production
// harness can produce: `verification` is built by the harness's own `verifyCounts`, events have the
// shape `ingestion-handler.ts` logs, and a job that ended `retry` leaves its version `queued`
// (`settle-failure.ts`) for good, because the harness runs no outbox dispatcher or recovery sweep
// and enqueues each job under a fixed id (`ingestion-bench-notes.mjs`). A retry that later succeeds
// or fails in the same scenario is therefore not producible and has no fixture.

import { verifyCounts } from "./ingestion-bench-rows.mjs";
import { changed, fullScenario, makeRun } from "./ingestion-compare-fixtures.mjs";
import { CONTROL_SCENARIOS } from "./ingestion-compare-server.mjs";

export const done = (outcome, extra) => ({ code: "INGESTION_JOB_DONE", outcome, ...extra });
export const retry = (failure = "stage.unexpected", stage = "chunking") =>
  done("retry", { stage, failure });
export const failed = (failure, stage = "chunking") => done("failed", { stage, failure });
export const processed = (n) => Array(n).fill(done("processed"));

/** A `statuses` row as the harness groups `document_versions`. */
export const row = (status, versions, { code = null, stage = null, attempt = 1 } = {}) => ({
  status,
  attempt,
  error_stage: stage,
  error_code: code,
  versions,
});

/** `verification` as `verifyCounts` builds it; each doc is `{ status, expect?, chunks? }`. */
export function verified(docs, statuses) {
  const found = docs.map((d, i) => {
    const chunks = d.chunks ?? (d.status === "ready" ? 4 : 0);
    return { id: `v${i}`, status: d.status, chunks, embeddings: chunks };
  });
  const items = docs.map((d, i) => ({
    versionId: `v${i}`,
    expect: d.expect ?? "accepted",
    expectedChunks: 4,
  }));
  return { statuses, ...verifyCounts(items, found) };
}

/** Ten documents, all processed and verified, the way the harness records a clean scenario. */
export const clean = (name = "sequential-max") => fullScenario(name, { serverStats: false });

/** A clean scenario edited by `edit`. */
export const scenarioWith = (edit) => changed(clean(), edit);

/** The `oversize-input` scenario: one document, rejected by the parser with `failure` at `stage`. */
export const rejected = (failure = "parse.text_too_large", stage = "parsing") =>
  changed(clean("oversize-input"), (s) => {
    s.jobs = 1;
    s.completed = 0;
    s.activationTransactions = 0;
    s.jobLog = [failed(failure, stage)];
    s.verification = verified(
      [{ expect: "rejected", status: "failed" }],
      [row("failed", 1, { code: failure, stage })],
    );
  });

/** Nine documents processed, one job ended with `event`, its version left as `ended` shows. */
export function unfinished(event, ended = row("queued", 1), edit = () => {}) {
  return changed(clean(), (s) => {
    s.completed = 9;
    s.activationTransactions = 9;
    s.jobLog = [...processed(9), event];
    s.verification = verified(
      [...Array(9).fill({ status: "ready" }), { status: ended.status }],
      [row("ready", 9), ended],
    );
    edit(s);
  });
}

/** A job whose activation statement was cancelled: retried as `stage.unexpected`, rolled back. */
export const cancelled = () =>
  unfinished(retry(), row("queued", 1), (s) => {
    s.statementErrors = [{ label: "chunks", code: "57014" }];
    s.transactionOutcomes = { commit: 10, rollback: 1 };
    s.activationTransactions = 10;
  });

/** A scenario whose verification failed with the harness's own problem texts. */
export const unverified = (reasons, mismatched = reasons.length) =>
  scenarioWith((s) => {
    s.verification.ok = false;
    s.verification.mismatchedVersions = mismatched;
    s.verification.problems = reasons.map((reason, index) => ({ index, reason }));
  });

/** A whole result of consistent scenarios (the four controls) that the loader accepts. */
export function runOf(scenarios = CONTROL_SCENARIOS.map(clean)) {
  const run = makeRun({ serverStats: false });
  run.scenarios = scenarios;
  return run;
}

/** The controls the loader requires, plus `extra` scenarios. */
export const withControls = (...extra) => runOf([...CONTROL_SCENARIOS.map(clean), ...extra]);

/** What `conclude()` writes when verification failed in a scenario. */
export function invalidRun(...scenarios) {
  const run = withControls(...scenarios);
  run.status = "invalid";
  run.error = `row-count verification failed in: ${scenarios.map((s) => s.name).join(", ")}`;
  return run;
}

export const codesOf = (outcome) => outcome.reasons.map((r) => r.code);
export const kindsOf = (outcome) => new Set(outcome.reasons.map((r) => r.kind));
