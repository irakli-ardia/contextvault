import { describe, expect, it } from "vitest";
import { standingOf } from "./ingestion-compare-outcomes.mjs";
import {
  clean,
  codesOf,
  done,
  failed,
  rejected,
  retry,
  runOf,
  scenarioWith,
} from "./ingestion-compare-outcomes-fixtures.mjs";

// Job events and the expected rejection (`ingestion-compare-outcomes-events.mjs`).
const standing = (...scenarios) => standingOf({ failures: [], result: runOf(scenarios) });
const only = (edit) => standing(scenarioWith(edit));
const withLog = (...events) => only((s) => s.jobLog.push(...events));
const reason = (result, code) => result.reasons.find((r) => r.code === code);

describe("retries and redeliveries", () => {
  it.each(["stage.unexpected", "handoff.missing", "embedding.rate_limited"])(
    "never accepts a retry for %s as a performance outcome",
    (failure) => {
      const result = withLog(retry(failure));
      expect(result.standing).toBe("invalid");
      expect(reason(result, "job-retry-unattributed")).toMatchObject({
        kind: "unresolved",
        detail: `chunking:${failure}`,
      });
    },
  );

  it("keeps every retry event, merged per recorded stage and failure", () => {
    const result = withLog(retry(), retry(), retry("handoff.missing", "parsing"));
    expect(result.reasons.filter((r) => r.code === "job-retry-unattributed")).toEqual([
      expect.objectContaining({ detail: "chunking:stage.unexpected", count: 2 }),
      expect.objectContaining({ detail: "parsing:handoff.missing", count: 1 }),
    ]);
  });

  it("does not count a retry as a terminal failure", () => {
    const result = only((s) => (s.jobLog[0] = retry()));
    expect(codesOf(result)).not.toContain("job-failed");
    expect(codesOf(result)).toContain("job-accounting-mismatch");
  });

  it("never accepts a redelivery, even next to a matching statement error and rollback", () => {
    const result = only((s) => {
      s.jobLog.push({ code: "INGESTION_JOB_REDELIVERED" });
      s.statementErrors = [{ label: "lockVersion", code: "40P01" }];
      s.transactionOutcomes = { commit: 10, rollback: 1 };
    });
    expect(result.standing).toBe("invalid");
    expect(reason(result, "job-redelivered-unattributed")).toMatchObject({ kind: "unresolved" });
    expect(reason(result, "statement-error")).toMatchObject({ kind: "performance" });
  });
});

describe("other job events", () => {
  it("is invalid for a terminal failure that no rejected document explains", () => {
    const result = withLog(failed("embedding.malformed_response"));
    expect(result.standing).toBe("invalid");
    expect(reason(result, "job-failed")).toMatchObject({
      detail: "chunking:embedding.malformed_response",
    });
    expect(codesOf(result)).toContain("job-accounting-mismatch");
  });

  it("is invalid for a worker error and for a rejected job", () => {
    const error = { code: "INGESTION_JOB_ERROR", reason: "db.permanent_error" };
    const rejectedJob = { code: "INGESTION_JOB_REJECTED", reason: "payload.invalid" };
    expect(codesOf(withLog(error))).toContain("job-error");
    expect(codesOf(withLog(rejectedJob))).toContain("job-rejected");
  });

  it.each([
    ["a lost lease", { code: "INGESTION_LEASE_LOST" }],
    ["an unknown claim outcome", { code: "INGESTION_CLAIM_OUTCOME_UNKNOWN" }],
    ["a consumer error", { code: "CONSUMER_ERROR" }],
  ])("names %s as a known but unsupported event", (_, event) => {
    const result = withLog(event);
    expect(result.standing).toBe("invalid");
    expect(reason(result, "job-event-unsupported")).toMatchObject({ detail: event.code });
  });

  it.each(["refused", "stale", "aborted"])("names a DONE %s as an unsupported outcome", (o) => {
    expect(reason(withLog(done(o)), "job-outcome-unsupported")).toMatchObject({
      detail: `DONE:${o}`,
    });
  });

  it.each([
    ["an unknown code", { code: "SOMETHING_NEW" }],
    ["an unknown outcome", done("bogus")],
    ["an outcome-less event", { code: "INGESTION_JOB_DONE" }],
    ["a code-less event", {}],
    ["a non-object event", "INGESTION_JOB_DONE"],
  ])("never accepts %s", (_, event) => {
    const result = withLog(event);
    expect(result.standing).toBe("invalid");
    expect(codesOf(result)).not.toContain("job-event-unsupported");
    expect(codesOf(result)).not.toContain("job-outcome-unsupported");
  });

  it("keeps every reason when a worker error and a retry occur together", () => {
    const result = only((s) => {
      s.jobLog[0] = retry();
      s.jobLog[1] = { code: "INGESTION_JOB_ERROR", reason: "ingestion.post_claim_error" };
    });
    expect(codesOf(result)).toEqual(
      expect.arrayContaining(["job-retry-unattributed", "job-error"]),
    );
  });

  it("flags a log with fewer terminal events than jobs, or none at all", () => {
    expect(codesOf(only((s) => s.jobLog.pop()))).toContain("job-accounting-mismatch");
    expect(codesOf(only((s) => delete s.jobLog))).toContain("job-log-missing");
  });
});

describe("the expected rejection", () => {
  const codes = (...scenarios) => codesOf(standing(clean(), ...scenarios));

  it.each([
    "parse.corrupt",
    "parse.encrypted",
    "parse.too_many_pages",
    "parse.no_text",
    "parse.invalid_encoding",
    "parse.timeout",
    "lease.expired",
  ])("never accepts %s in place of parse.text_too_large", (failure) => {
    const result = standing(clean(), rejected(failure));
    expect(result.standing).toBe("invalid");
    expect(codesOf(result)).toEqual(expect.arrayContaining(["job-failed", "version-not-ready"]));
  });

  it("keeps a parse timeout visible as a performance reason beside the unresolved ones", () => {
    const result = standing(clean(), rejected("parse.timeout"));
    expect(reason(result, "parse-timeout")).toMatchObject({ kind: "performance" });
  });

  it("requires the parsing stage on the event and on the version row", () => {
    expect(codes(rejected("parse.text_too_large", "chunking"))).toEqual(
      expect.arrayContaining(["job-failed", "version-not-ready"]),
    );
  });

  it("requires a first attempt and the failed status", () => {
    const retried = rejected();
    retried.verification.statuses[0].attempt = 2;
    expect(codes(retried)).toContain("version-not-ready");
    const queued = rejected();
    queued.verification.statuses[0] = { ...queued.verification.statuses[0], status: "queued" };
    expect(codes(queued)).toContain("version-not-ready");
  });

  it("requires one job and no activation", () => {
    const [two, activated] = [rejected(), rejected()];
    two.jobs = 2;
    activated.activationTransactions = 1;
    expect(codes(two)).toContain("rejection-evidence-mismatch");
    expect(codes(activated)).toContain("rejection-evidence-mismatch");
  });

  it("is expected only in the oversize-input scenario", () => {
    const other = { ...rejected(), name: "sequential-max" };
    expect(codes(other)).toEqual(expect.arrayContaining(["job-failed", "version-not-ready"]));
  });
});
