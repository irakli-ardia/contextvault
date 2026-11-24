import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changed, makeRun } from "./ingestion-compare-fixtures.mjs";
import { loadFile, loadText, validateResult } from "./ingestion-compare-load.mjs";
import { compareProvenance, normalizeProvenance } from "./ingestion-compare-provenance.mjs";

const codes = (result) => validateResult(result).failures.map((f) => f.code);
const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "compare-evidence-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("malformed structures never throw", () => {
  it.each([
    ["cli.arguments as a string", (r) => (r.cli.arguments = "run --execute")],
    ["numbers in cli.arguments", (r) => r.cli.arguments.push(5)],
    ["cli as a list", (r) => (r.cli = [])],
    ["scenarios as an object with find", (r) => (r.scenarios = { find: 1 })],
    ["scenarios holding null", (r) => (r.scenarios = [null, 3, "x"])],
    ["config as a string", (r) => (r.config = "x")],
    ["containers as a list", (r) => (r.containers = [])],
    ["environment as a string", (r) => (r.environment = "x")],
    ["schema as a list", (r) => (r.schema = [])],
    ["schema.ddl as a number", (r) => (r.schema.ddl = 3)],
    ["cleanup as a string", (r) => (r.cleanup = "ok")],
  ])("%s becomes an invalid entry with the bytes hashed", (_name, edit) => {
    const bytes = JSON.stringify(changed(makeRun(), edit));
    const entry = loadText("a.json", bytes);
    expect(entry.valid).toBe(false);
    expect(entry.failures.length).toBeGreaterThan(0);
    expect(entry.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("keeps a run valid when only its server data is malformed", () => {
    const run = changed(makeRun(), (r) => {
      r.serverStats = 3;
      r.scenarios[0].serverStatements = "x";
    });
    const entry = loadText("a.json", JSON.stringify(run));
    expect(entry.valid).toBe(true);
    expect(entry.server.scenarios["sequential-small"].status).toBe("invalid");
    expect(entry.server.issues).toHaveLength(1);
  });

  it("reports a bad command line with its own code", () => {
    expect(codes(changed(makeRun(), (r) => (r.cli.arguments = "run")))).toContain("cli-arguments");
    expect(codes(changed(makeRun(), (r) => r.cli.arguments.push(5)))).toContain("cli-arguments");
  });
});

describe("missing evidence fails closed", () => {
  it.each([
    ["experimentId", (r) => delete r.experimentId, "experiment-id"],
    ["completedAt", (r) => delete r.completedAt, "timestamp"],
    ["startedAt", (r) => delete r.startedAt, "timestamp"],
    ["environment", (r) => delete r.environment, "environment"],
    ["an environment without a host", (r) => delete r.environment.cpu, "environment"],
    ["containers", (r) => (r.containers = {}), "container"],
    ["a redis container", (r) => delete r.containers.redis, "container"],
    ["an image id", (r) => delete r.containers.postgres.imageId, "container"],
    ["a malformed image id", (r) => (r.containers.redis.imageId = "sha256:abc"), "container"],
    ["a null memory limit", (r) => (r.containers.postgres.memoryLimitBytes = null), "container"],
    ["a cpu limit", (r) => delete r.containers.redis.cpuLimit, "container"],
    ["a non-finite pids limit", (r) => (r.containers.redis.pidsLimit = Number.NaN), "container"],
    ["a zero cpu limit", (r) => (r.containers.postgres.cpuLimit = 0), "container"],
    ["baseline schema column", (r) => delete r.schema.column, "schema-column"],
    ["baseline schema ddl", (r) => delete r.schema.ddl, "schema-ddl"],
    ["schema metadata", (r) => delete r.schema, "legacy"],
    ["a command line that does not match the config", (r) => (r.config.repeats = 5), "cli-config"],
    [
      "a command line with an unknown option",
      (r) => r.cli.arguments.push("--x=1"),
      "cli-arguments",
    ],
    ["a repeated option", (r) => r.cli.arguments.push("--rounds=3"), "cli-arguments"],
  ])("rejects a run without %s", (_name, edit, code) => {
    expect(codes(changed(makeRun(), edit))).toContain(code);
  });

  it("does not compare two equally incomplete runs as valid", () => {
    const bare = (i) =>
      changed(makeRun({ index: i }), (r) => {
        r.containers = {};
        delete r.environment;
      });
    const a = loadText("a.json", JSON.stringify(bare(0)));
    const b = loadText("b.json", JSON.stringify(bare(1)));
    expect([a.valid, b.valid]).toEqual([false, false]);
  });
});

describe("timestamps", () => {
  const withTimes = (startedAt, completedAt) =>
    changed(makeRun(), (r) => Object.assign(r, { startedAt, completedAt }));
  it.each([
    ["an impossible date", "2026-02-30T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
    ["a month 13", "2026-13-01T00:00:00.000Z", "2026-13-02T00:00:00.000Z"],
    ["no milliseconds", "2026-11-20T09:00:00Z", "2026-11-20T09:00:01.000Z"],
    ["an offset", "2026-11-20T09:00:00.000+01:00", "2026-11-20T10:00:00.000Z"],
    ["completion before start", "2026-11-20T09:00:00.001Z", "2026-11-20T09:00:00.000Z"],
    ["a null completion", "2026-11-20T09:00:00.000Z", null],
  ])("rejects %s", (_name, start, end) => {
    expect(codes(withTimes(start, end))).toContain("timestamp");
  });

  it("accepts equal and one-millisecond-later times, and a leap day", () => {
    expect(codes(withTimes("2028-02-29T00:00:00.000Z", "2028-02-29T00:00:00.000Z"))).toEqual([]);
    expect(codes(withTimes("2026-11-20T09:00:00.999Z", "2026-11-20T09:00:01.000Z"))).toEqual([]);
  });
});

describe("input safety", () => {
  it("never quotes the input in a parse error", () => {
    const entry = loadText("a.json", "SECRET_TOKEN=abcdef123456");
    expect(entry.failures).toEqual([
      { code: "malformed-json", detail: "the file is not valid JSON" },
    ]);
  });

  it("hashes the raw bytes of a file through loadFile", () => {
    const path = join(tmp(), "a.json");
    writeFileSync(path, `${JSON.stringify(makeRun(), null, 2)}\n`);
    const entry = loadFile(path);
    expect(entry.valid).toBe(true);
    expect(entry.sha256).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
  });

  it("refuses a symlink, a directory and a missing file without reading them", () => {
    const dir = tmp();
    writeFileSync(join(dir, "real.json"), JSON.stringify(makeRun()));
    symlinkSync(join(dir, "real.json"), join(dir, "link.json"));
    mkdirSync(join(dir, "dir.json"));
    const refuse = () => {
      throw new Error("must not read");
    };
    expect(loadFile(join(dir, "link.json"), refuse).failures[0]).toEqual({
      code: "unsupported-file-type",
      detail: "symlink",
    });
    expect(loadFile(join(dir, "dir.json"), refuse).failures[0].code).toBe("unsupported-file-type");
    expect(loadFile(join(dir, "none.json"), refuse).failures[0].code).toBe("unreadable");
  });

  it("refuses a FIFO or device by file type", () => {
    const stat = () => ({ isFile: () => false, isSymbolicLink: () => false });
    const refuse = () => {
      throw new Error("must not read");
    };
    expect(loadFile("pipe.json", refuse, stat).failures[0].code).toBe("unsupported-file-type");
  });
});

describe("command-line order", () => {
  const prov = (r) => ({ file: r.runId, provenance: normalizeProvenance(r) });
  const swap = (r) => {
    const a = r.cli.arguments;
    [a[2], a[3]] = [a[3], a[2]];
  };

  it("compares reordered equivalent arguments as equal", () => {
    const reordered = changed(makeRun({ index: 1 }), swap);
    expect(codes(reordered)).toEqual([]);
    expect(compareProvenance([prov(makeRun()), prov(reordered)]).consistent).toBe(true);
  });

  it.each([
    ["a changed value", (r) => (r.cli.arguments[3] = "--repeats=5")],
    ["an added option", (r) => r.cli.arguments.push("--smoke")],
    ["a removed flag", (r) => r.cli.arguments.splice(2, 1)],
  ])("fails comparison for %s", (_name, edit) => {
    const other = changed(makeRun({ index: 1 }), edit);
    expect(compareProvenance([prov(makeRun()), prov(other)]).consistent).toBe(false);
  });
});

describe("committed legacy evidence", () => {
  it.each(["run1", "run2", "run3"])("rejects %s only as legacy", (name) => {
    const path = join(
      import.meta.dirname,
      `../../benchmarks/ingestion/ingestion-clean-${name}.json`,
    );
    const entry = loadFile(path);
    expect(entry.failures.map((f) => f.code)).toEqual(["legacy"]);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(entry.controls)).toHaveLength(4);
  });
});
