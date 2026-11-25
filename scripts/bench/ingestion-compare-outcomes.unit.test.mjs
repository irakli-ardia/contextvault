import { describe, expect, it } from "vitest";
import { standingOf } from "./ingestion-compare-outcomes.mjs";
import {
  clean,
  codesOf,
  rejected,
  runOf,
  scenarioWith,
  unverified,
} from "./ingestion-compare-outcomes-fixtures.mjs";

const standing = (...scenarios) => standingOf({ failures: [], result: runOf(scenarios) });
const only = (edit) => standing(scenarioWith(edit));
const reason = (result, code) => result.reasons.find((r) => r.code === code);

describe("a verified run", () => {
  it("is valid with no reasons, including the expected parser rejection", () => {
    expect(standing(clean())).toEqual({ standing: "valid", reasons: [] });
    expect(standing(clean(), rejected())).toEqual({ standing: "valid", reasons: [] });
  });
});

describe("statement errors", () => {
  const errors = (...list) => only((s) => (s.statementErrors = list));
  const lockError = (rollback) =>
    only((s) => {
      s.statementErrors = [{ label: "lockDocument", code: "40P01" }];
      s.transactionOutcomes = { commit: 40, rollback };
      s.activationTransactions = 10 + rollback;
    });

  it("keeps 57014 unresolved: the record cannot tell a statement timeout from another cancel", () => {
    const result = errors({ label: "chunks", code: "57014" });
    expect(result.standing).toBe("invalid");
    expect(reason(result, "statement-cancelled-unattributed")).toMatchObject({
      kind: "unresolved",
      detail: "chunks:57014",
    });
  });

  // Synthetic: the worker's own handling of a lock error also logs a retry, redelivery or error
  // event, which is unresolved. This is the only way `outcome` is reachable.
  it("shows a transient lock error as a performance reason, accepted only when nothing else is open", () => {
    const result = lockError(1);
    expect(result.standing).toBe("outcome");
    expect(result.reasons).toEqual([
      expect.objectContaining({ kind: "performance", code: "statement-error", count: 1 }),
    ]);
  });

  it("lets one transient error account for at most one rollback", () => {
    const result = lockError(3);
    expect(result.standing).toBe("invalid");
    expect(reason(result, "rollback-unexplained")).toMatchObject({ kind: "unresolved", count: 2 });
  });

  it.each(["23505", "42P01", "Error", undefined])(
    "does not accept %s as a performance outcome",
    (code) => {
      expect(errors({ label: "other", code }).standing).toBe("invalid");
    },
  );

  it("is invalid when the statement errors are missing", () => {
    expect(codesOf(only((s) => delete s.statementErrors))).toContain("statement-errors-missing");
  });

  it("does not explain a rollback without a recorded statement error", () => {
    const result = only((s) => (s.transactionOutcomes = { commit: 40, rollback: 2 }));
    expect(reason(result, "rollback-unexplained")).toMatchObject({ count: 2 });
  });

  it("never accepts a failed commit or rollback statement", () => {
    expect(codesOf(only((s) => (s.transactionOutcomes = { commit: 39, error: 1 })))).toContain(
      "transaction-error",
    );
  });

  it("flags activation transactions that no completed job accounts for", () => {
    expect(codesOf(only((s) => (s.activationTransactions = 11)))).toContain(
      "activation-transactions-mismatch",
    );
  });
});

describe("verification evidence", () => {
  it.each([
    ["version missing", "version-missing", "correctness"],
    ["rejected document was activated", "rejected-activated", "correctness"],
    ["status running", "status-not-ready", "unresolved"],
    ["chunks 3, expected 4", "chunk-count-mismatch", "correctness"],
    ["embeddings 3, chunks 4", "embedding-count-mismatch", "correctness"],
    ["something else", "verification-unrecognized", "correctness"],
  ])("classifies %j as %s (%s)", (text, code, kind) => {
    const result = standing(unverified([text]));
    expect(result.standing).toBe("invalid");
    expect(result.reasons).toContainEqual(expect.objectContaining({ kind, code }));
  });

  it("is unresolved when the recorded problems are truncated, missing or absent", () => {
    expect(codesOf(standing(unverified(Array(20).fill("status failed"), 25)))).toContain(
      "verification-truncated",
    );
    expect(codesOf(standing(unverified([], 3)))).toContain("verification-truncated");
    expect(codesOf(only((s) => delete s.verification))).toContain("verification-missing");
  });

  it("is unresolved when verification checked a different number of versions", () => {
    expect(codesOf(only((s) => (s.verification.checked = 9)))).toContain("verification-incomplete");
  });

  it("flags an ok verification that contradicts itself", () => {
    expect(codesOf(only((s) => (s.verification.mismatchedVersions = 2)))).toContain(
      "verification-contradiction",
    );
  });

  it("flags versions that are not all activated", () => {
    expect(codesOf(only((s) => (s.completed = 9)))).toContain("activation-mismatch");
    expect(codesOf(only((s) => delete s.verification.statuses))).toContain("statuses-missing");
  });

  it("never accepts a ready version that took more than one attempt", () => {
    const result = only((s) => (s.verification.statuses[0].attempt = 2));
    expect(result.standing).toBe("invalid");
    expect(reason(result, "version-reattempted")).toMatchObject({ kind: "unresolved" });
  });
});

describe("scenarios", () => {
  it("never infers a missing scenario field: absent evidence is never success", () => {
    expect(standing({ name: "bare" }).standing).toBe("invalid");
    expect(standing("not a scenario").reasons).toContainEqual(
      expect.objectContaining({ code: "scenario-malformed" }),
    );
  });

  it("attributes each reason to its scenario", () => {
    const result = standing(clean("a"), unverified(["status failed"]));
    expect(new Set(result.reasons.map((r) => r.scope))).toEqual(new Set(["sequential-max"]));
  });
});
