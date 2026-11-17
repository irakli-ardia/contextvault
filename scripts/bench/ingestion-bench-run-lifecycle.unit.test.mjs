import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./ingestion-bench.mjs";
import { parseArgs } from "./ingestion-bench-args.mjs";

const docker = (args) => ({
  status: 0,
  stdout: args[0] === "context" && args[1] === "show" ? "default" : "unix:///var/run/docker.sock",
  stderr: "",
});
const GONE = { removed: true };
const step = (calls, name, value) => {
  calls.push(name);
  return value;
};

/** Stages that record their order; `overrides` replaces one to inject a failure. */
function fakeStages(calls, overrides = {}) {
  const bundle = { dir: mkdtempSync(join(tmpdir(), "ingbench-test-")) };
  return {
    bundle,
    stages: {
      buildBundles: () => step(calls, "bundle", bundle),
      prepare: async () => step(calls, "prepare", { inspect: [], urls: { app: "", fixture: "" } }),
      startRedis: async () => step(calls, "redis", { inspect: [], port: 1 }),
      measure: async ({ state }) => {
        calls.push("measure");
        state.schema.verified = true;
      },
      removePostgres: () => step(calls, "rm-pg", GONE),
      removeRedis: () => step(calls, "rm-redis", GONE),
      ...overrides,
    },
  };
}

const originalExit = process.exitCode;
afterEach(() => {
  process.exitCode = originalExit;
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ingbench-out-"));
  const out = join(dir, "result.json");
  return { out, opts: parseArgs(["run", "--execute", "--smoke", `--out=${out}`]) };
}

describe("run lifecycle", () => {
  it("runs the phases in order, then cleans up and writes a complete result", async () => {
    const calls = [];
    const { out, opts } = setup();
    const { stages, bundle } = fakeStages(calls);
    await run(opts, [], docker, stages);
    expect(calls).toEqual(["bundle", "prepare", "redis", "measure", "rm-pg", "rm-redis"]);
    expect(JSON.parse(readFileSync(out, "utf8")).status).toBe("complete");
    expect(existsSync(bundle.dir)).toBe(false);
    expect(process.exitCode).toBe(originalExit);
  });

  it("records a failed measurement with its message, still cleans up and fails the exit code", async () => {
    const calls = [];
    const { out, opts } = setup();
    const { stages, bundle } = fakeStages(calls, {
      measure: async () => {
        throw new Error("boom");
      },
    });
    await run(opts, [], docker, stages);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result).toMatchObject({ status: "failed", failedDuring: "setup", error: "boom" });
    expect(calls.slice(-2)).toEqual(["rm-pg", "rm-redis"]);
    expect(existsSync(bundle.dir)).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("cleans up when the bundle build fails, without starting any container step", async () => {
    const calls = [];
    const { opts } = setup();
    const { stages } = fakeStages(calls, {
      buildBundles: () => {
        throw new Error("no bundle");
      },
    });
    await run(opts, [], docker, stages);
    expect(calls).toEqual(["rm-pg", "rm-redis"]);
    expect(process.exitCode).toBe(1);
  });

  it("fails the exit code when cleanup cannot be verified, even after a complete measurement", async () => {
    const { out, opts } = setup();
    const { stages } = fakeStages([], { removeRedis: () => ({ removed: false }) });
    await run(opts, [], docker, stages);
    expect(JSON.parse(readFileSync(out, "utf8")).cleanup.verified).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("records a cleanup that throws as unverified and still publishes", async () => {
    const { out, opts } = setup();
    const { stages, bundle } = fakeStages([], {
      removeRedis: () => {
        throw new Error("daemon unreachable");
      },
    });
    await run(opts, [], docker, stages);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result.cleanup).toMatchObject({ verified: false, error: "daemon unreachable" });
    expect(existsSync(bundle.dir)).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("refuses before any stage or cleanup when the result file already exists", async () => {
    const calls = [];
    const { out, opts } = setup();
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, "existing");
    const { stages } = fakeStages(calls);
    await expect(run(opts, [], docker, stages)).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(readFileSync(out, "utf8")).toBe("existing");
  });
});

/** A process stand-in: records handlers and exits instead of exiting the test runner. */
function fakeProc() {
  const handlers = new Map();
  const exits = [];
  return {
    on: (signal, handler) => handlers.set(signal, handler),
    off: (signal) => handlers.delete(signal),
    exit: (code) => exits.push(code),
    fire: (signal) => handlers.get(signal)?.(),
    exits,
    handlers,
  };
}

describe("run lifecycle on a signal", () => {
  /** Measures one scenario, then is interrupted twice (SIGINT, SIGTERM) before it can finish. */
  const interrupted = (calls, proc) =>
    fakeStages(calls, {
      measure: async ({ state }) => {
        state.scenarios.push({ name: "done-before-signal", verification: { ok: true } });
        state.currentScenario = "burst-4-max-c2-r1";
        proc.fire("SIGINT");
        proc.fire("SIGTERM");
        throw new Error("aborted by signal");
      },
    });

  it("publishes the measured scenarios as interrupted with verified cleanup, exiting 130 once", async () => {
    const calls = [];
    const proc = fakeProc();
    const { out, opts } = setup();
    const { stages, bundle } = interrupted(calls, proc);
    await run(opts, [], docker, stages, proc);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result).toMatchObject({
      status: "interrupted",
      interruptedDuring: "burst-4-max-c2-r1",
      cleanup: { verified: true },
    });
    expect(result.scenarios.map((s) => s.name)).toEqual(["done-before-signal"]);
    expect(proc.exits).toEqual([130]);
    expect(existsSync(bundle.dir)).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("tears down and publishes once: the normal end after a signal does neither again", async () => {
    const calls = [];
    const proc = fakeProc();
    const { opts } = setup();
    const { stages } = interrupted(calls, proc);
    await run(opts, [], docker, stages, proc);
    expect(calls.filter((c) => c === "rm-pg")).toHaveLength(1);
    expect(calls.filter((c) => c === "rm-redis")).toHaveLength(1);
    expect(proc.handlers.size).toBe(0);
  });

  it("still publishes and exits when cleanup throws inside the handler", async () => {
    const proc = fakeProc();
    const { out, opts } = setup();
    const { stages } = fakeStages([], {
      measure: async () => {
        proc.fire("SIGTERM");
        throw new Error("aborted by signal");
      },
      removePostgres: () => {
        throw new Error("docker gone");
      },
    });
    await run(opts, [], docker, stages, proc);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result).toMatchObject({ status: "interrupted", cleanup: { verified: false } });
    expect(proc.exits).toEqual([143]);
  });
});
