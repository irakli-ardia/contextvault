import { describe, expect, it } from "vitest";
import { changed, fullScenario } from "./ingestion-compare-fixtures.mjs";
import { scenarioMetrics } from "./ingestion-compare-metrics.mjs";

const edit = (fn, name) => scenarioMetrics(changed(fullScenario(name), fn));

describe("job events", () => {
  const done = (outcome, extra = {}) => ({ code: "INGESTION_JOB_DONE", outcome, ...extra });
  const retry = done("retry", { stage: "embedding", failure: "embed.timeout" });
  const failed = done("failed", { stage: "parsing", failure: "parse.text_too_large" });
  const events = (log) => edit((s) => (s.jobLog = log)).reliability.jobEvents;

  it("counts a successful job", () => {
    expect(events([done("processed")])).toMatchObject({ total: 1, processed: 1, retry: 0 });
  });

  it("does not count a retry as a failure, nor retry-then-success as a failed job", () => {
    expect(events([retry, done("processed")])).toMatchObject({ retry: 1, processed: 1, failed: 0 });
    expect(events([retry, retry, retry, done("processed")])).toMatchObject({ retry: 3, failed: 0 });
  });

  it("counts retries and the terminal failure as separate events", () => {
    const e = events([
      retry,
      retry,
      done("failed", { stage: "embedding", failure: "embed.timeout" }),
    ]);
    expect(e).toMatchObject({ total: 3, retry: 2, failed: 1 });
    expect(e.reasons.retry).toEqual({ "embed.timeout": 2 });
    expect(e.reasons.failed).toEqual({ "embed.timeout": 1 });
  });

  it("reads worker errors and rejections by their reason", () => {
    const e = events([
      { code: "INGESTION_JOB_ERROR", reason: "ingestion.post_claim_error" },
      { code: "INGESTION_JOB_REJECTED", reason: "payload.invalid" },
      { code: "INGESTION_JOB_REJECTED", reason: "payload.invalid" },
    ]);
    expect(e).toMatchObject({ error: 1, rejected: 2, failed: 0, retry: 0 });
    expect(e.reasons.error).toEqual({ "ingestion.post_claim_error": 1 });
    expect(e.reasons.rejected).toEqual({ "payload.invalid": 2 });
  });

  it("separates a mixed sequence and keeps a missing code as unknown", () => {
    const e = events([
      done("processed"),
      retry,
      failed,
      done("failed"),
      { code: "INGESTION_JOB_ERROR" },
      { code: "INGESTION_JOB_REDELIVERED" },
      done("aborted"),
    ]);
    expect(e).toMatchObject({ total: 7, processed: 1, retry: 1, failed: 2, error: 1, other: 2 });
    expect(e.reasons.failed).toEqual({ "parse.text_too_large": 1, unknown: 1 });
    expect(e.reasons.error).toEqual({ unknown: 1 });
  });

  it("counts malformed records as other and tolerates a missing log", () => {
    const e = events([null, 5, "x", [], { outcome: "failed" }, { code: 7, outcome: "retry" }]);
    expect(e).toMatchObject({ total: 6, other: 6, failed: 0, retry: 0 });
    expect(edit((s) => delete s.jobLog).reliability.jobEvents).toBeNull();
  });
});
