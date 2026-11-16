import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./ingestion-bench.mjs";
import { parseArgs } from "./ingestion-bench-args.mjs";
import { SERVER_ARGS } from "./ingestion-bench-server-stats.mjs";

const docker = (args) => ({
  status: 0,
  stdout: args[0] === "context" && args[1] === "show" ? "default" : "unix:///var/run/docker.sock",
  stderr: "",
});
const originalExit = process.exitCode;
afterEach(() => {
  process.exitCode = originalExit;
});

/** Stages that record what they were given; `measure` may be replaced to inject a failure. */
function harness(measure) {
  const seen = { calls: [] };
  const dir = mkdtempSync(join(tmpdir(), "ingbench-stats-"));
  const stages = {
    buildBundles: () => ({ dir }),
    prepare: async (_docker, pg) => {
      seen.pg = pg;
      return { inspect: { Id: "x" }, urls: { app: "", fixture: "" } };
    },
    startRedis: async () => ({ inspect: [], port: 1 }),
    measure: async (args) => {
      seen.measure = args;
      await measure?.(args);
    },
    removePostgres: () => {
      seen.calls.push("rm-pg");
      return { removed: true };
    },
    removeRedis: () => {
      seen.calls.push("rm-redis");
      return { removed: true };
    },
  };
  return { seen, stages };
}

async function execute(flags, measure) {
  const out = join(mkdtempSync(join(tmpdir(), "ingbench-out-")), "result.json");
  const { seen, stages } = harness(measure);
  const opts = parseArgs(["run", "--execute", "--smoke", `--out=${out}`, ...flags]);
  await run(opts, [], docker, stages);
  return { seen, result: JSON.parse(readFileSync(out, "utf8")) };
}

describe("without --server-stats", () => {
  it("keeps the container arguments, configuration, notes and measurement call unchanged", async () => {
    const { seen, result } = await execute([]);
    expect(seen.pg.args.at(-1)).toBe(seen.pg.image);
    expect(seen.measure.opts.serverStats).toBe(false);
    expect(result.config).not.toHaveProperty("serverStats");
    expect(result).not.toHaveProperty("serverStats");
    expect(result.measurements.serverExecution).toMatch(/^Not measured/);
    expect(result.limitations.join()).toMatch(/no database-server execution time is measured/);
    expect(result.plan.join()).not.toMatch(/server statistics/);
  });
});

describe("with --server-stats", () => {
  it("starts the server with the settings, hands the accepted container to the measurement and says so in the result", async () => {
    const { seen, result } = await execute(["--server-stats"]);
    expect(seen.pg.args.slice(-SERVER_ARGS.length)).toEqual(SERVER_ARGS);
    expect(seen.measure.accepted).toEqual({ Id: "x" });
    expect(result.config.serverStats).toBe(true);
    expect(result.measurements.serverExecution).toMatch(/serverStatements/);
    expect(result.measurements.serverExecution).toMatch(/not per transaction/);
    expect(result.measurements.clientSqlMs).toMatch(/NOT PostgreSQL execution time/);
    expect(result.limitations.join()).not.toMatch(/no database-server execution time is measured/);
    expect(result.limitations.join()).toMatch(/never compared across databases/);
    expect(result.plan.join()).toMatch(/server statistics/);
  });

  it("reports an instrumentation failure explicitly and still removes both containers", async () => {
    const { seen, result } = await execute(["--server-stats"], async () => {
      throw new Error("server statistics refused: container id");
    });
    expect(result).toMatchObject({
      status: "failed",
      error: "server statistics refused: container id",
    });
    expect(result.cleanup.verified).toBe(true);
    expect(seen.calls).toEqual(["rm-pg", "rm-redis"]);
    expect(process.exitCode).toBe(1);
  });
});
