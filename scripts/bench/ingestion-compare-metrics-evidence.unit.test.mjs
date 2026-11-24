import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadText } from "./ingestion-compare-load.mjs";
import { scenarioMetrics } from "./ingestion-compare-metrics.mjs";

const evidence = (n) =>
  JSON.parse(
    readFileSync(
      new URL(`../../benchmarks/ingestion/ingestion-clean-run${n}.json`, import.meta.url),
    ),
  );
const real = evidence(1);
const realScenario = (name) => real.scenarios.find((s) => s.name === name);

describe("against the committed evidence", () => {
  it("matches the recorded values of a real scenario", () => {
    const r = realScenario("sequential-max");
    const m = scenarioMetrics(r);
    expect(m.wallMs).toBe(r.wallMs);
    expect(m.activations).toBe(r.activationTransactions);
    expect(m.expectedChunks).toBe(r.dataset.expectedChunks);
    expect(m.timings.max.embedMs.median).toBe(r.summary.max.embedMs.median);
    expect(m.timings.max.activationTxMs.p95).toBe(r.summary.max.activationTxMs.p95);
    expect(m.db.walBytesPerChunk).toBe(r.db.walBytesPerChunk);
    expect(m.db.counters.xact_commit).toBe(r.db.counters.xact_commit);
    expect(m.server).toBeNull();
  });

  it("reproduces every recorded statistic of every real scenario", () => {
    for (const file of [1, 2, 3]) {
      const run = JSON.parse(
        readFileSync(
          new URL(`../../benchmarks/ingestion/ingestion-clean-run${file}.json`, import.meta.url),
        ),
      );
      const entry = loadText(`run${file}.json`, JSON.stringify(run));
      for (const [i, s] of run.scenarios.entries()) {
        const m = entry.metrics[i];
        expect(m).toMatchObject({ name: s.name, wallMs: s.wallMs, completed: s.completed });
        expect(m.db).toMatchObject({ walBytes: s.db.walBytes, postgresCpuMs: s.db.postgresCpuMs });
        expect(m.reliability.transactionOutcomes).toMatchObject(s.transactionOutcomes);
        expect(m.reliability.jobEvents.total).toBe(s.jobLog.length);
        expect(m.reliability.maxAttempt).toBe(
          Math.max(...s.verification.statuses.map((x) => x.attempt)),
        );
        for (const [cls, group] of Object.entries(s.summary)) {
          for (const [field, stat] of Object.entries(group)) {
            if (typeof stat === "object" && m.timings[cls][field]) {
              for (const q of ["n", "min", "median", "p95", "max", "mean"])
                expect(m.timings[cls][field][q]).toBe(stat[q] ?? null);
            }
          }
        }
      }
    }
  });

  it("extracts all four document classes of the mixed workload", () => {
    const m = scenarioMetrics(realScenario("workspace-mixed-c2"));
    expect(Object.keys(m.timings)).toEqual(["small", "medium", "large", "max"]);
    expect(m.timings.large.docs).toBe(realScenario("workspace-mixed-c2").summary.large.docs);
  });

  it("reads the oversize-input scenario: one failed job, no activation", () => {
    const m = scenarioMetrics(realScenario("oversize-input"));
    expect(m).toMatchObject({ activations: 0, completed: 0, docsPerMinute: 0 });
    expect(m.reliability).toMatchObject({ maxAttempt: 1 });
    expect(m.reliability.jobEvents).toEqual({
      total: 1,
      processed: 0,
      retry: 0,
      failed: 1,
      error: 0,
      rejected: 0,
      other: 0,
      reasons: { retry: {}, failed: { "parse.text_too_large": 1 }, error: {}, rejected: {} },
    });
    expect(m.timings["input-limit"].activationTxMs.median).toBeNull();
  });
});
