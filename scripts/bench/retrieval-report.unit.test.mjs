import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderReport } from "./retrieval-report.mjs";

const dir = new URL("../../benchmarks/retrieval/", import.meta.url);
const results = JSON.parse(readFileSync(new URL("results.json", dir), "utf8"));

describe("committed benchmark artifacts", () => {
  it("report.md is exactly the rendering of results.json (timeouts included)", () => {
    const report = readFileSync(new URL("report.md", dir), "utf8");
    expect(renderReport(results)).toBe(report);
    expect(report).toContain("timeout");
  });

  it("carries only metadata the current script produces", () => {
    expect(Object.keys(results.environment).sort()).toEqual(
      [
        "appStatementTimeout",
        "cpu",
        "memoryGb",
        "node",
        "pgvector",
        "platform",
        "postgres",
        "rowsBeforeSeed",
        "runsPerMeasurement",
        "settings",
        "smoke",
      ].sort(),
    );
  });
});

describe("renderReport with unavailable measurements", () => {
  const fresh = () => structuredClone(results);
  const timedOut = { timeout: true, completedRuns: [] };

  it("shows n/a for query vectors that timed out, also after a JSON round trip", () => {
    const r = fresh();
    r.sizes[0].vectorQueries = [null, undefined, 12.3];
    const report = renderReport(JSON.parse(JSON.stringify(r)));
    expect(report).toContain("wall median ms: n/a, n/a, 12.3.");
  });

  it("never sums or prints NaN when a vector wall timed out", () => {
    const r = fresh();
    r.sizes[0].vector["wall-50"] = timedOut;
    r.sizes[0].vector["wall-5"] = { timeout: true, completedRuns: [1, 2] };
    r.sizes[0].hybrid.rare.vectorOnlyWall5 = undefined;
    const report = renderReport(r);
    expect(report).not.toMatch(/NaN|undefined|null/);
    const hybrid = report.split("## 10000 chunks")[0].split("**Hybrid**")[1];
    expect(hybrid).toContain("| rare | ");
    expect(hybrid.split("\n").find((l) => l.startsWith("| rare"))).toContain("| timeout |");
  });

  it("reports a missing measurement as n/a instead of a sum", () => {
    const r = fresh();
    delete r.sizes[0].vector["wall-50"].median;
    const rare = renderReport(r)
      .split("**Hybrid**")[1]
      .split("\n")
      .find((l) => l.startsWith("| rare"));
    expect(rare).toContain("| n/a |");
  });

  it("leaves a keyword timeout as timeout in the sum column", () => {
    const r = fresh();
    r.sizes[0].keyword.rare["wall-50"] = timedOut;
    const rare = renderReport(r)
      .split("**Hybrid**")[1]
      .split("\n")
      .find((l) => l.startsWith("| rare"));
    expect(rare).toContain("| timeout |");
  });
});
