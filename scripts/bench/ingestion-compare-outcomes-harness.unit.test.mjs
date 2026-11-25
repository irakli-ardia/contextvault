// Every case runs through `loadText` (`validateResult` and `standingOf`) on a state the production
// harness can write; see the fixtures for why each is reachable. Run-level cases (interrupted, failed,
// schema, cleanup) and the committed baseline are in `ingestion-compare-outcomes-run.unit.test.mjs`.

import { describe, expect, it } from "vitest";
import { changed } from "./ingestion-compare-fixtures.mjs";
import { loadText } from "./ingestion-compare-load.mjs";
import {
  cancelled,
  clean,
  codesOf,
  failed,
  invalidRun,
  kindsOf,
  processed,
  rejected,
  retry,
  row,
  unfinished,
  verified,
  withControls,
} from "./ingestion-compare-outcomes-fixtures.mjs";

const load = (run) => loadText("run.json", JSON.stringify(run));
const reason = (entry, code) => entry.standing.reasons.find((r) => r.code === code);
const loaderCodes = (entry) => entry.failures.map((f) => f.code);
const ready = (n, extra) => Array(n).fill({ status: "ready", ...extra });

describe("a successful run", () => {
  it("is valid, with the expected rejection and without reasons", () => {
    const entry = load(withControls(rejected()));
    expect(entry).toMatchObject({ valid: true, failures: [], standing: { standing: "valid" } });
    expect(entry.standing.reasons).toEqual([]);
  });
});

describe("a job that ended retry", () => {
  it("leaves the run invalid: an unattributed 57014 is never a timeout or a defect", () => {
    const entry = load(invalidRun(cancelled()));
    expect(entry.valid).toBe(false);
    expect(loaderCodes(entry)).toEqual(expect.arrayContaining(["status", "scenario-verification"]));
    expect(entry.standing.standing).toBe("invalid");
    expect(codesOf(entry.standing)).toEqual(
      expect.arrayContaining([
        "statement-cancelled-unattributed",
        "job-retry-unattributed",
        "status-not-ready",
        "version-not-ready",
      ]),
    );
    expect(kindsOf(entry.standing)).toEqual(new Set(["unresolved"]));
  });

  it.each(["stage.unexpected", "handoff.missing"])(
    "leaves a not-ready version that is unresolved, not a proven defect (%s)",
    (failure) => {
      const entry = load(invalidRun(unfinished(retry(failure))));
      expect(entry.standing.standing).toBe("invalid");
      expect(reason(entry, "version-not-ready")).toMatchObject({
        kind: "unresolved",
        detail: "queued:unknown",
      });
      expect(kindsOf(entry.standing).has("correctness")).toBe(false);
    },
  );

  it("keeps a retry and an independent terminal failure as separate counted reasons", () => {
    const failure = "embedding.malformed_response";
    const mixed = changed(clean(), (s) => {
      s.completed = 8;
      s.activationTransactions = 8;
      s.jobLog = [...processed(8), retry(), failed(failure)];
      s.verification = verified(
        [...ready(8), { status: "queued" }, { status: "failed" }],
        [row("ready", 8), row("queued", 1), row("failed", 1, { code: failure, stage: "chunking" })],
      );
    });
    const entry = load(invalidRun(mixed));
    expect(reason(entry, "job-retry-unattributed")).toMatchObject({ count: 1 });
    expect(reason(entry, "job-failed")).toMatchObject({ count: 1, detail: `chunking:${failure}` });
    expect(kindsOf(entry.standing)).toEqual(new Set(["unresolved"]));
  });

  it("does not let a retry hide an unrelated correctness failure", () => {
    const hidden = changed(clean(), (s) => {
      s.completed = 9;
      s.activationTransactions = 9;
      s.jobLog = [...processed(9), retry()];
      s.verification = verified(
        [...ready(8), { status: "ready", chunks: 3 }, { status: "queued" }],
        [row("ready", 9), row("queued", 1)],
      );
    });
    const entry = load(invalidRun(hidden));
    expect(reason(entry, "chunk-count-mismatch")).toMatchObject({ kind: "correctness" });
    expect(reason(entry, "job-retry-unattributed")).toMatchObject({ kind: "unresolved" });
  });
});

describe("a redelivery", () => {
  it("stays unresolved beside a statement error and rollback that may be unrelated to it", () => {
    const redelivered = changed(clean(), (s) => {
      s.jobLog.push({ code: "INGESTION_JOB_REDELIVERED" });
      s.statementErrors = [{ label: "lockVersion", code: "40P01" }];
      s.transactionOutcomes = { commit: 10, rollback: 1 };
    });
    const entry = load(withControls(redelivered));
    expect(entry.valid).toBe(true);
    expect(entry.standing.standing).toBe("invalid");
    expect(reason(entry, "job-redelivered-unattributed")).toMatchObject({ kind: "unresolved" });
    expect(reason(entry, "statement-error")).toMatchObject({ kind: "performance" });
  });
});

describe("a worker error", () => {
  it("is unresolved, with the version it left running", () => {
    const error = { code: "INGESTION_JOB_ERROR", reason: "ingestion.post_claim_error" };
    const entry = load(invalidRun(unfinished(error, row("running", 1))));
    expect(entry.standing.standing).toBe("invalid");
    expect(reason(entry, "job-error")).toMatchObject({ detail: "ingestion.post_claim_error" });
    expect(kindsOf(entry.standing)).toEqual(new Set(["unresolved"]));
  });
});

describe("the expected rejection", () => {
  it("is valid only for parse.text_too_large at parsing", () => {
    expect(load(withControls(rejected())).standing.standing).toBe("valid");
  });

  it.each(["parse.corrupt", "parse.timeout"])(
    "is invalid for %s although the harness's verification passes",
    (failure) => {
      const entry = load(withControls(rejected(failure)));
      expect(entry.valid).toBe(true);
      expect(entry.standing.standing).toBe("invalid");
      expect(codesOf(entry.standing)).toEqual(
        expect.arrayContaining(["job-failed", "version-not-ready"]),
      );
    },
  );

  it("keeps performance and unresolved reasons side by side", () => {
    const timeout = changed(rejected("parse.timeout"), (s) => {
      s.statementErrors = [{ label: "lockDocument", code: "40P01" }];
      s.transactionOutcomes = { commit: 3, rollback: 1 };
    });
    const entry = load(withControls(timeout));
    expect(kindsOf(entry.standing)).toEqual(new Set(["performance", "unresolved"]));
    expect(codesOf(entry.standing)).toEqual(
      expect.arrayContaining(["statement-error", "parse-timeout", "job-failed"]),
    );
  });
});

describe("a statement error beside a correctness failure", () => {
  it("is invalid and keeps both, in either order of precedence", () => {
    const wrong = changed(clean(), (s) => {
      s.statementErrors = [{ label: "lockDocument", code: "40P01" }];
      s.transactionOutcomes = { commit: 10, rollback: 1 };
      s.verification = verified([...ready(9), { status: "ready", chunks: 3 }], [row("ready", 10)]);
    });
    const entry = load(invalidRun(wrong));
    expect(entry.standing.standing).toBe("invalid");
    expect(reason(entry, "statement-error")).toMatchObject({ kind: "performance" });
    expect(reason(entry, "chunk-count-mismatch")).toMatchObject({ kind: "correctness" });
  });
});

describe("missing or truncated verification", () => {
  it("is invalid when a scenario has no verification", () => {
    const entry = load(withControls(changed(clean(), (s) => delete s.verification)));
    expect(entry.valid).toBe(false);
    expect(entry.standing.standing).toBe("invalid");
  });

  it("is unresolved when the harness's 20-problem cap hid some mismatches", () => {
    const many = changed(clean(), (s) => {
      s.jobs = 25;
      s.completed = 0;
      s.activationTransactions = 0;
      s.jobLog = Array(25).fill(retry());
      s.verification = verified(Array(25).fill({ status: "queued" }), [row("queued", 25)]);
    });
    expect(many.verification.problems).toHaveLength(20);
    const entry = load(invalidRun(many));
    expect(reason(entry, "verification-truncated")).toMatchObject({ kind: "unresolved" });
    expect(reason(entry, "job-retry-unattributed")).toMatchObject({ count: 25 });
  });
});
