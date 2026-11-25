// Interprets the consumer's `INGESTION_JOB_*` log as the harness records it (`code`, `outcome`,
// `stage`, `failure`, `reason` only). Every event but a processed job or the one expected parser
// rejection is `unresolved`: the events carry no job id, so none can be tied to a version, and a
// retry or redelivery is never evidence of a performance cause. See `ingestion-compare-outcomes.mjs`.

import { get, str } from "./ingestion-compare-metrics.mjs";

/** The one expected rejection: `ingestion-bench-plan.mjs` seeds one document of the input limit. */
export const OVERSIZE = {
  scenario: "oversize-input",
  stage: "parsing",
  failure: "parse.text_too_large",
};
/** Codes the ingestion consumer emits that the classifier does not interpret (never `performance`). */
const UNSUPPORTED_CODES = new Set([
  "INGESTION_LEASE_LOST",
  "INGESTION_CLAIM_OUTCOME_UNKNOWN",
  "INGESTION_HEARTBEAT_RECOVERED",
  "INGESTION_HEARTBEAT_FAILED",
  "INGESTION_SHUTDOWN_CANCELLING",
  "INGESTION_SHUTDOWN_FORCED",
  "INGESTION_SHUTDOWN_INCOMPLETE",
  "CONSUMER_ERROR",
  "CONSUMER_CLOSE_FAILED",
  "REDIS_ERROR",
]);
const UNSUPPORTED_OUTCOMES = new Set(["refused", "stale", "aborted"]);
const PARSE_TIMEOUT = "parse.timeout";
/** Untrusted text kept in a reason: a string, bounded; never stringified from another type. */
export const label = (v) => (typeof v === "string" && v !== "" ? v.slice(0, 60) : "unknown");

function failedEvent(add, rejection, stage, failure) {
  const expected = rejection && stage === OVERSIZE.stage && failure === OVERSIZE.failure;
  if (!expected) add("unresolved", "job-failed", `${label(stage)}:${label(failure)}`);
  if (failure === PARSE_TIMEOUT) add("performance", "parse-timeout", label(stage));
}

function doneEvent(e, add, rejection) {
  const [outcome, stage, failure] = [str(get(e, "outcome")), get(e, "stage"), get(e, "failure")];
  if (outcome === "processed") return "processed";
  if (outcome === "failed") {
    failedEvent(add, rejection, stage, failure);
    return "failed";
  }
  if (outcome === "retry")
    add("unresolved", "job-retry-unattributed", `${label(stage)}:${label(failure)}`);
  else {
    const code = UNSUPPORTED_OUTCOMES.has(outcome)
      ? "job-outcome-unsupported"
      : "unrecognized-event";
    add("unresolved", code, `DONE:${label(outcome)}`);
  }
  return "other";
}

export function jobEvents(s, add, rejection) {
  const log = get(s, "jobLog");
  const tally = { processed: 0, failed: 0 };
  if (!Array.isArray(log)) {
    add("unresolved", "job-log-missing");
    return tally;
  }
  for (const e of log) {
    const code = str(get(e, "code"));
    const reason = label(get(e, "reason"));
    if (code === "INGESTION_JOB_DONE") {
      const kind = doneEvent(e, add, rejection);
      if (kind in tally) tally[kind] += 1;
    } else if (code === "INGESTION_JOB_REDELIVERED")
      add("unresolved", "job-redelivered-unattributed");
    else if (code === "INGESTION_JOB_ERROR") add("unresolved", "job-error", reason);
    else if (code === "INGESTION_JOB_REJECTED") add("unresolved", "job-rejected", reason);
    else
      add(
        "unresolved",
        UNSUPPORTED_CODES.has(code) ? "job-event-unsupported" : "unrecognized-event",
        label(code),
      );
  }
  return tally;
}
