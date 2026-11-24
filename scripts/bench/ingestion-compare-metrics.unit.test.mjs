import { describe, expect, it } from "vitest";
import { changed, fullScenario, makeRun } from "./ingestion-compare-fixtures.mjs";
import { loadText, validateResult } from "./ingestion-compare-load.mjs";
import { scenarioMetrics } from "./ingestion-compare-metrics.mjs";

const metrics = (name = "sequential-max") => scenarioMetrics(fullScenario(name));
const edit = (fn, name) => scenarioMetrics(changed(fullScenario(name), fn));
const chunks = (m) => m.server.classes.chunks;

describe("real-shaped extraction", () => {
  it("reads identity, workload and timings", () => {
    const m = metrics();
    expect(m).toMatchObject({
      name: "sequential-max",
      concurrency: 1,
      sequential: true,
      documents: 10,
      expectedChunks: 11130,
      jobs: 10,
      completed: 10,
      activations: 10,
      verified: true,
    });
    expect(m.timings.max).toMatchObject({
      docs: 10,
      completed: 10,
      embedMs: { n: 10, median: 103, max: 103 },
      activationTxMs: { median: 104 },
      chunkInsertClientMs: { median: 105 },
    });
    expect(m.db).toMatchObject({ walBytes: 112594592, chunksAdded: 11130 });
    expect(m.db.counters.xact_rollback).toBe(0);
    expect(m.db.sizesAfter.chunks.heap).toBe(3284992);
    expect(m.load).toEqual({
      workerCpuCores: 0.61,
      postgresCpuCores: 0.27,
      eventLoopUtilization: 0.58,
      saturated: [],
    });
  });

  it("reads server classes, lock waits and validity", () => {
    const run = makeRun();
    const v = validateResult(run).server.scenarios["sequential-max"];
    const m = scenarioMetrics(fullScenario(), v);
    expect(m.server).toMatchObject({ status: "valid", deallocations: 0, appRoleCalls: 0 });
    expect(chunks(m)).toEqual({
      calls: 10,
      clientCalls: 10,
      totalExecMs: 50,
      maxExecMs: 9,
      rows: 10,
      walBytes: 100,
      callsMatch: true,
    });
    expect(m.server.lockWaits).toEqual({ count: 0, resolved: 0, totalMs: 0, maxMs: 0 });
    expect(m.server.other).toBeNull();
  });

  it("does not expose per-statement averages", () => {
    expect(chunks(metrics())).not.toHaveProperty("meanExecMs");
  });
});

describe("server statistics", () => {
  const server = (fn) => edit((s) => fn(s.serverStatements));

  it("is null when the scenario has no server data", () => {
    const m = scenarioMetrics(fullScenario("sequential-max", { serverStats: false }));
    expect(m.server).toBeNull();
    expect(m.timings.max.activationTxMs.median).toBe(104);
  });

  it("keeps client data when the server data is invalid", () => {
    const m = server((d) => {
      d.classes = "broken";
      d.lockWaits = [];
    });
    expect(m.server.classes.chunks).toBeNull();
    expect(m.server.lockWaits).toBeNull();
    expect(m.timings.max.embedMs.median).toBe(103);
    expect(m.db.walBytes).toBe(112594592);
  });

  it("keeps a class with a malformed figure and nulls only that figure", () => {
    const m = server((d) => {
      d.classes.chunks.calls = "10";
      d.classes.chunks.callsMatch = "yes";
      d.classes.chunks.totalExecMs = 0;
    });
    expect(chunks(m)).toMatchObject({
      calls: null,
      callsMatch: null,
      totalExecMs: 0,
      maxExecMs: 9,
    });
  });

  it("records an unmatched call count and the class the server never saw", () => {
    const m = server((d) => {
      d.classes.chunks.callsMatch = false;
      delete d.classes.markReady;
    });
    expect(chunks(m).callsMatch).toBe(false);
    expect(m.server.classes.markReady).toBeNull();
  });

  it("carries the 3b-1 validity verdict", () => {
    const run = changed(makeRun(), (r) => (r.scenarios[3].serverStatements.deallocations = 3));
    const v = validateResult(run).server.scenarios["sequential-max"];
    const m = scenarioMetrics(run.scenarios[3], v);
    expect(m.server.status).toBe("invalid");
    expect(m.server.reasons).toEqual(["deallocations: 3"]);
  });
});

describe("failed and zero-activation scenarios", () => {
  it("reports a failed job without inventing timings", () => {
    const m = edit((s) => {
      s.activationTransactions = 0;
      s.statementErrors = [{ label: "chunks", code: "57014" }];
      s.transactionOutcomes = { rollback: 2, error: 1 };
      s.verification.statuses = [
        {
          status: "failed",
          attempt: 3,
          error_stage: "activating",
          error_code: "db.permanent_error",
          versions: 1,
        },
        { status: "ready", attempt: 1, error_stage: null, error_code: null, versions: 9 },
      ];
    });
    expect(m.activations).toBe(0);
    expect(m.reliability).toMatchObject({
      transactionOutcomes: { commit: null, rollback: 2, error: 1 },
      statementErrors: { total: 1, byCode: { "chunks:57014": 1 } },
      maxAttempt: 3,
    });
  });

  it("reads an oversize scenario from the fixtures", () => {
    const m = scenarioMetrics(fullScenario("oversize-input", { oversize: true }));
    expect(m).toMatchObject({ completed: 0, activations: 0 });
    expect(m.reliability.jobEvents).toMatchObject({ total: 10, failed: 10, processed: 0 });
  });
});

describe("purity and loader integration", () => {
  it("is deterministic and does not mutate its input", () => {
    const s = fullScenario();
    const before = JSON.stringify(s);
    const a = scenarioMetrics(s);
    expect(scenarioMetrics(s)).toEqual(a);
    expect(JSON.stringify(s)).toBe(before);
    expect(Object.isFrozen(a)).toBe(false);
  });

  it("adds metrics to loaded entries without changing validity or the checksum", () => {
    const text = JSON.stringify(makeRun({ arm: "stored-tsv" }));
    const entry = loadText("a.json", text);
    expect(entry.valid).toBe(true);
    expect(entry.metrics).toHaveLength(15);
    expect(entry.metrics[3].name).toBe("sequential-max");
    expect(entry.metrics[3].server.status).toBe("valid");
    expect(entry.metrics[4]).toMatchObject({ name: "oversize-input", activations: 0 });
    expect(Object.keys(entry)).toEqual(
      expect.arrayContaining(["sha256", "failures", "provenance"]),
    );
  });

  it("keeps metrics on an invalid run and drops none for invalid server data", () => {
    const run = changed(makeRun(), (r) => {
      r.status = "failed";
      r.scenarios[3].serverStatements = 7;
    });
    const entry = loadText("b.json", JSON.stringify(run));
    expect(entry.valid).toBe(false);
    expect(entry.metrics).toHaveLength(15);
    expect(entry.metrics[3].server).toBeNull();
    expect(entry.metrics[3].timings.max.embedMs.median).toBe(750);
  });

  it("matches server validity by scenario position, not by name", () => {
    const run = changed(makeRun(), (r) => {
      r.scenarios[1].name = r.scenarios[0].name;
      r.scenarios[0].serverStatements.deallocations = 3;
    });
    const entry = loadText("d.json", JSON.stringify(run));
    expect(entry.metrics[0].server.status).toBe("invalid");
    expect(entry.metrics[1].server.status).toBe("valid");
  });

  it("gives non-run inputs no metrics", () => {
    expect(loadText("c.json", "{").metrics).toBeUndefined();
    expect(validateResult(5).metrics).toBeUndefined();
    expect(validateResult({ scenarios: 5 }).metrics).toEqual([]);
  });
});
