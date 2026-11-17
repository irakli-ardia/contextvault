import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./ingestion-bench.mjs";
import { parseArgs } from "./ingestion-bench-args.mjs";
import { plan } from "./ingestion-bench-plan.mjs";
import { prepareSchema, SNAPSHOT_SQL, STORED_TSV_DDL } from "./ingestion-bench-schema.mjs";

const docker = (args) => ({
  status: 0,
  stdout: args[0] === "context" && args[1] === "show" ? "default" : "unix:///var/run/docker.sock",
  stderr: "",
});
const originalExit = process.exitCode;
afterEach(() => {
  process.exitCode = originalExit;
});

const BASE = {
  session: { user: "contextvault_owner", super: false, bypassRls: false },
  rls: { enabled: true, forced: true },
  policies: [],
  selectable: { app: ["id"], worker: ["id"] },
  updatable: { app: [], worker: [] },
  column: null,
  indexed: false,
};
const COLUMN = {
  type: "tsvector",
  generated: "s",
  notNull: true,
  expression: "to_tsvector('simple'::regconfig, content)",
};
const STORED = {
  ...BASE,
  column: COLUMN,
  selectable: { app: ["content_tsv", "id"], worker: ["id"] },
};

/** A pg Client class whose connection answers like a fresh owner session; records connect/end. */
function fakeClient(log, { snapshots, ddlFails = false }) {
  return class {
    async connect() {
      log.push("connect");
    }
    async end() {
      log.push("end");
    }
    async query(sql) {
      if (sql.includes("shobj_description")) return { rows: [{ marker: "m1" }] };
      if (sql === STORED_TSV_DDL) {
        log.push("ddl");
        if (ddlFails) throw new Error("ddl boom");
        return { rows: [] };
      }
      if (sql === SNAPSHOT_SQL) return { rows: [{ x: JSON.stringify(snapshots.shift()) }] };
      throw new Error("unexpected statement");
    }
  };
}

/**
 * Stages for the real `run` orchestration (result file, failure recording, cleanup, exit code).
 * Coverage limit: the production `measure` stage needs Docker, PostgreSQL and the worker bundle, so
 * it is replaced here by a stand-in that calls the real `prepareSchema` first. The tests below
 * therefore prove the schema step, its failure handling and `run`'s cleanup, not the order of
 * `measure`'s own steps (isolation, schema, server statistics, scenarios), which is read from
 * ingestion-bench-measure.mjs and covered only by a real smoke run.
 */
function stages(log, schemaClient, arm) {
  const bundle = { dir: mkdtempSync(join(tmpdir(), "ingbench-schema-")) };
  const step = (name, value) => {
    log.push(name);
    return value;
  };
  return {
    bundle,
    stages: {
      buildBundles: () => step("bundle", bundle),
      prepare: async () => step("prepare", { inspect: [], urls: {} }),
      startRedis: async () => step("redis", { inspect: [], port: 1 }),
      measure: async ({ state }) => {
        await prepareSchema({ pgClient: schemaClient, url: "x", marker: "m1", arm, state });
        log.push("scenario");
      },
      removePostgres: () => step("rm-pg", { removed: true }),
      removeRedis: () => step("rm-redis", { removed: true }),
    },
  };
}
const outFile = () => join(mkdtempSync(join(tmpdir(), "ingbench-out-")), "result.json");
const options = (arm, out, extra = []) =>
  parseArgs(["run", "--execute", "--smoke", `--schema=${arm}`, ...extra, `--out=${out}`]);

describe("schema arm lifecycle", () => {
  it("runs the schema step before the stand-in scenario, then cleans up", async () => {
    const log = [];
    const out = outFile();
    const client = fakeClient(log, { snapshots: [BASE, STORED] });
    const { stages: s } = stages(log, client, "stored-tsv");
    await run(options("stored-tsv", out, ["--server-stats"]), [], docker, s);
    expect(log).toEqual([
      "bundle",
      "prepare",
      "redis",
      "connect",
      "ddl",
      "end",
      "scenario",
      "rm-pg",
      "rm-redis",
    ]);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result).toMatchObject({ status: "complete", cleanup: { verified: true } });
    expect(result.schema).toMatchObject({ arm: "stored-tsv", verified: true, column: COLUMN });
    expect(result.config.serverStats).toBe(true);
  });

  it("records the baseline arm too, without any DDL", async () => {
    const log = [];
    const out = outFile();
    const { stages: s } = stages(log, fakeClient(log, { snapshots: [BASE, BASE] }), "baseline");
    await run(options("baseline", out), [], docker, s);
    expect(log).not.toContain("ddl");
    expect(JSON.parse(readFileSync(out, "utf8")).schema).toMatchObject({
      arm: "baseline",
      verified: true,
    });
  });

  it("fails the run before any scenario when verification fails, with cleanup and the reason kept", async () => {
    const log = [];
    const out = outFile();
    const wrong = { ...STORED, column: { ...COLUMN, generated: "v" } };
    const { stages: s, bundle } = stages(
      log,
      fakeClient(log, { snapshots: [BASE, wrong] }),
      "stored-tsv",
    );
    await run(options("stored-tsv", out), [], docker, s);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result.status).toBe("failed");
    expect(result.schema).toMatchObject({ arm: "stored-tsv", verified: false });
    expect(result.schema.error).toMatch(/not a stored/);
    expect(log).not.toContain("scenario");
    expect(log.slice(-3)).toEqual(["end", "rm-pg", "rm-redis"]);
    expect(result.cleanup.verified).toBe(true);
    expect(existsSync(bundle.dir)).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("fails and cleans up when the DDL itself throws", async () => {
    const log = [];
    const out = outFile();
    const client = fakeClient(log, { snapshots: [BASE], ddlFails: true });
    const { stages: s } = stages(log, client, "stored-tsv");
    await run(options("stored-tsv", out), [], docker, s);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result).toMatchObject({ status: "failed", cleanup: { verified: true } });
    expect(result.schema).toMatchObject({ verified: false, error: "ddl boom" });
    expect(log).not.toContain("scenario");
  });

  it("never reports complete while the arm is unverified", async () => {
    const out = outFile();
    const { stages: s } = stages([], fakeClient([], { snapshots: [] }), "baseline");
    s.measure = async ({ state }) => {
      state.schema = { arm: "stored-tsv", verified: false };
    };
    await run(options("stored-tsv", out), [], docker, s);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      status: "invalid",
      error: "schema arm not verified",
    });
  });

  it.each([
    ["missing", undefined],
    ["undefined", { arm: "stored-tsv", verified: undefined }],
    ["null", { arm: "stored-tsv", verified: null }],
    ["truthy but not true", { arm: "stored-tsv", verified: "yes" }],
  ])("never reports complete when schema verification is %s", async (_name, schema) => {
    const out = outFile();
    const { stages: s } = stages([], fakeClient([], { snapshots: [] }), "baseline");
    s.measure = async ({ state }) => {
      state.schema = schema;
    };
    await run(options("stored-tsv", out), [], docker, s);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      status: "invalid",
      error: "schema arm not verified",
    });
  });

  it("an omitted --schema leaves the result arm baseline and the plan unchanged", () => {
    expect(parseArgs(["run", "--execute"]).schema).toBe("baseline");
    const lines = plan(parseArgs(["plan"]));
    expect(lines.join("\n")).not.toMatch(/stored-tsv/);
    expect(plan(parseArgs(["plan", "--schema=stored-tsv"])).join("\n")).toMatch(/stored-tsv/);
  });

  it("closes the owner session when the arm fails", async () => {
    const log = [];
    const state = {};
    const client = fakeClient(log, {
      snapshots: [{ ...BASE, rls: { enabled: true, forced: false } }],
    });
    await expect(
      prepareSchema({ pgClient: client, url: "x", marker: "m1", arm: "stored-tsv", state }),
    ).rejects.toThrow(/RLS/);
    expect(log).toEqual(["connect", "end"]);
  });
});
