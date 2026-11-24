import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changed, makeRun, serverStatements } from "./ingestion-compare-fixtures.mjs";
import { loadText, validateResult } from "./ingestion-compare-load.mjs";

const codes = (result) => validateResult(result).failures.map((f) => f.code);
const named = (run, name) => run.scenarios.find((s) => s.name === name);

describe("fixtures match the harness result structure", () => {
  const real = JSON.parse(
    readFileSync(new URL("../../benchmarks/ingestion/ingestion-clean-run1.json", import.meta.url)),
  );
  const fixture = makeRun();
  const added = ["schema", "serverStats"];

  it("records no top-level field the harness does not", () => {
    const unknown = Object.keys(fixture).filter((k) => !(k in real) && !added.includes(k));
    expect(unknown).toEqual([]);
  });

  it("records no scenario or summary field the harness does not", () => {
    const [r] = real.scenarios.filter((s) => s.name === "sequential-max");
    const f = named(fixture, "sequential-max");
    expect(Object.keys(f).filter((k) => !(k in r) && k !== "serverStatements")).toEqual([]);
    expect(Object.keys(f.summary.max.embedMs)).toEqual(Object.keys(r.summary.max.embedMs));
    expect(Object.keys(f.verification)).toEqual(Object.keys(r.verification));
  });

  it("uses the real scenario names and the real command line shape", () => {
    expect(fixture.scenarios.map((s) => s.name)).toEqual(real.scenarios.map((s) => s.name));
    expect(fixture.cli.arguments[0]).toBe(real.cli.arguments[0]);
    expect(Object.keys(fixture.config).filter((k) => !(k in real.config))).toEqual(["serverStats"]);
    expect(Object.keys(fixture.environment)).toEqual(Object.keys(real.environment));
    expect(fixture.containers.postgres).toEqual({
      ...real.containers.postgres,
      image: expect.any(String),
    });
  });

  it("builds server statements with the harness summarizer", () => {
    expect(Object.keys(serverStatements())).toEqual([
      "valid",
      "invalidReasons",
      "deallocations",
      "statsResetAt",
      "classes",
      "other",
      "appRoleCalls",
      "lockWaits",
    ]);
    expect(serverStatements().valid).toBe(true);
  });
});

describe("server statistics", () => {
  const server = (run) => validateResult(run).server;
  const first = (run) => run.scenarios[3];

  it("reports valid data per scenario and lock waits", () => {
    const run = changed(makeRun(), (r) => (first(r).serverStatements.lockWaits.count = 2));
    const { enabled, scenarios } = server(run);
    expect(enabled).toBe(true);
    expect(scenarios["sequential-max"]).toMatchObject({ status: "valid", lockWaits: { count: 2 } });
    expect(scenarios["oversize-input"].status).toBe("valid");
  });

  it("reports a run without the flag as disabled, not as a failure", () => {
    const run = makeRun({ serverStats: false });
    expect(server(run)).toEqual({ enabled: false, scenarios: {}, issues: [] });
    expect(codes(run)).toEqual([]);
  });

  it("reports a scenario with no data as missing and keeps the run valid", () => {
    const run = changed(makeRun(), (r) => delete first(r).serverStatements);
    expect(server(run).scenarios["sequential-max"].status).toBe("missing");
    expect(codes(run)).toEqual([]);
  });

  it("reports invalid data with the harness reasons and keeps the run valid", () => {
    const run = changed(makeRun(), (r) => {
      Object.assign(first(r).serverStatements, {
        valid: false,
        invalidReasons: ["chunks: server 3 calls, client 2"],
      });
    });
    expect(server(run).scenarios["sequential-max"]).toMatchObject({
      status: "invalid",
      reasons: ["chunks: server 3 calls, client 2"],
    });
    expect(codes(run)).toEqual([]);
    expect(loadText("a.json", JSON.stringify(run)).valid).toBe(true);
  });

  it("reports positive deallocations", () => {
    const run = changed(
      makeRun(),
      (r) => (first(r).serverStatements = serverStatements({ dealloc: 4 })),
    );
    const entry = server(run).scenarios["sequential-max"];
    expect(entry.status).toBe("invalid");
    expect(entry.reasons).toContain("deallocations: 4");
    expect(entry.deallocations).toBe(4);
  });

  it("reports missing statement classes only where activations ran", () => {
    const run = changed(makeRun(), (r) => {
      first(r).serverStatements = serverStatements({ omit: ["chunks"] });
      named(r, "oversize-input").serverStatements = serverStatements({ omit: ["chunks"] });
    });
    const { scenarios } = server(run);
    expect(scenarios["sequential-max"].missingClasses).toEqual(["chunks"]);
    expect(scenarios["oversize-input"].missingClasses).toEqual([]);
  });

  it("reports malformed data and unverified metadata without throwing", () => {
    const run = changed(makeRun(), (r) => {
      first(r).serverStatements = "oops";
      r.serverStats.containerIdentityVerified = false;
    });
    expect(server(run).scenarios["sequential-max"].status).toBe("invalid");
    expect(server(run).issues).toHaveLength(1);
  });

  it("reports server data recorded without the flag", () => {
    const run = changed(makeRun({ serverStats: false }), (r) => {
      first(r).serverStatements = serverStatements();
    });
    expect(server(run).issues).toEqual(["server data without the flag"]);
  });
});

describe("control values", () => {
  it.each([
    ["negative", -1],
    ["not finite", Number.NaN],
    ["a string", "700"],
    ["null", null],
  ])("rejects a median that is %s", (_name, value) => {
    const run = changed(
      makeRun(),
      (r) => (named(r, "burst-20-max-c1-r2").summary.max.embedMs.median = value),
    );
    const entry = validateResult(JSON.parse(JSON.stringify(run)));
    expect(entry.failures).toContainEqual({
      code: "control-invalid",
      detail: "burst-20-max-c1-r2",
    });
    expect(entry.controls["burst-20-max-c1-r2"]).toBeUndefined();
  });

  it("rejects a missing scenario and a missing sample count", () => {
    const run = changed(makeRun(), (r) => {
      r.scenarios = r.scenarios.filter((s) => s.name !== "sequential-max");
      named(r, "burst-20-max-c1-r1").summary.max.embedMs.n = 0;
    });
    const failures = validateResult(run).failures.map((f) => `${f.code}:${f.detail}`);
    expect(failures).toEqual(
      expect.arrayContaining([
        "control-missing:sequential-max",
        "control-invalid:burst-20-max-c1-r1",
      ]),
    );
  });
});

describe("malformed server values never invalidate the run", () => {
  const withStatements = (value) =>
    changed(makeRun(), (r) => (named(r, "sequential-small").serverStatements = value));
  const valid = () => serverStatements();

  it.each([
    ["an object toString", { ...valid(), deallocations: { toString: 1 } }],
    ["a nested array", { ...valid(), deallocations: [[[1]]] }],
    ["a string", { ...valid(), deallocations: "0" }],
    ["NaN-like null", { ...valid(), deallocations: null }],
    ["hostile invalidReasons", { ...valid(), invalidReasons: [{ toString: 1 }, 5, "ok"] }],
    ["hostile classes entries", { ...valid(), classes: { sections: { calls: { toString: 1 } } } }],
  ])("%s stays a server-only problem with the controls kept", (_name, data) => {
    const entry = loadText("a.json", JSON.stringify(withStatements(data)));
    expect(entry.failures).toEqual([]);
    expect(entry.valid).toBe(true);
    expect(Object.keys(entry.controls)).toHaveLength(4);
    const scenario = entry.server.scenarios["sequential-small"];
    expect(scenario.status).toBe("invalid");
    expect(JSON.stringify(scenario)).not.toContain("toString");
  });

  it("keeps a hostile scenario name from throwing", () => {
    const run = changed(makeRun(), (r) => (r.scenarios[0].name = { toString: 1 }));
    const entry = loadText("a.json", JSON.stringify(run));
    expect(entry.failures.map((f) => f.code)).not.toContain("structure");
  });
});
