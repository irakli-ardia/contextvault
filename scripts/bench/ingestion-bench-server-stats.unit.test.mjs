import { describe, expect, it } from "vitest";
import {
  SERVER_ARGS,
  SERVER_SETTINGS,
  ServerStatsError,
  SQL,
  verifyFacts,
} from "./ingestion-bench-server-stats.mjs";
import {
  facts,
  fakeDocker,
  psqlInputs,
  roles,
  spec,
  start,
} from "./ingestion-bench-server-stats-support.mjs";
import { containerSpec } from "./keyword-experiment-container.mjs";

describe("server arguments", () => {
  it("preload the library and set tracking after the image", () => {
    expect(SERVER_ARGS.slice(0, 3)).toEqual([
      "postgres",
      "-c",
      "shared_preload_libraries=pg_stat_statements",
    ]);
    expect(spec.args.slice(-SERVER_ARGS.length)).toEqual(SERVER_ARGS);
    expect(spec.args.at(-SERVER_ARGS.length - 1)).toBe(spec.image);
    expect(SERVER_ARGS).toContain("pg_stat_statements.track_planning=off");
  });
  it("leave the argument list byte-identical without them", () => {
    expect(containerSpec({ id: "0a1b2c3d" }).args.at(-1)).toBe(spec.image);
    expect(containerSpec({ id: "0a1b2c3d" }).args).toEqual(
      containerSpec({ id: "0a1b2c3d", serverArgs: [] }).args,
    );
  });
});

describe("initialization failures", () => {
  it("aborts when the extension cannot be created", async () => {
    const { docker, calls } = fakeDocker({ fail: SQL.install });
    await expect(start(docker)).rejects.toThrow(ServerStatsError);
    expect(psqlInputs(calls)).not.toContain(SQL.verify);
  });
  it("aborts on unreadable verification output", async () => {
    const { docker } = fakeDocker({ answers: { [SQL.verify]: "psql: not a document {" } });
    await expect(start(docker)).rejects.toThrow("unreadable psql output");
  });
  it.each([
    ["not superuser", facts({ superuser: false })],
    [
      "a wrong setting",
      facts({ settings: { ...SERVER_SETTINGS, "pg_stat_statements.track": "all" } }),
    ],
    ["the extension in public", facts({ extensionSchema: "public" })],
    [
      "a role that can use the schema",
      facts({ roles: roles({ contextvault_app: { schemaUsage: true } }) }),
    ],
    [
      "a role that can reset",
      facts({ roles: roles({ contextvault_fixture: { canReset: true } }) }),
    ],
    [
      "a worker that bypasses RLS",
      facts({ roles: roles({ contextvault_worker: { bypassRls: true } }) }),
    ],
    ["a missing role", facts({ roles: roles().slice(1) })],
  ])("verification refuses %s", (_, bad) =>
    expect(() => verifyFacts(bad)).toThrow(ServerStatsError),
  );
  it("accepts the isolated installation", () => expect(() => verifyFacts(facts())).not.toThrow());
});

describe("reset and snapshot boundaries", () => {
  it("resets, then reads once, only through the allowed statements, never reading query ids", async () => {
    const { docker, calls } = fakeDocker({ answers: { logs: "" } });
    const stats = await start(docker);
    stats.reset();
    stats.read({ transactions: [], errors: [] });
    expect(psqlInputs(calls).slice(-2)).toEqual([SQL.reset, SQL.read]);
    expect(SQL.read).not.toMatch(/queryid/i);
    expect(SQL.read).toMatch(
      /dbid = \(select oid from pg_database where datname = current_database\(\)\)/,
    );
  });
  it("counts only lock waits logged after the reset", async () => {
    let log = "LOG: process 1 still waiting for ShareLock on transaction 5 after 100.1 ms\n";
    const { docker } = fakeDocker();
    const wrapped = (args, opts) =>
      args[0] === "logs" ? { status: 0, stdout: "", stderr: log } : docker(args, opts);
    const stats = await start(wrapped);
    stats.reset();
    log +=
      "LOG: process 2 still waiting for ShareLock on transaction 6 after 100.2 ms\nLOG: process 2 acquired ShareLock on transaction 6 after 250.5 ms\n";
    const result = stats.read({ transactions: [], errors: [] });
    expect(result.lockWaits).toEqual({ count: 1, resolved: 1, totalMs: 250.5, maxMs: 250.5 });
  });
  it("reports a failed read as an error, not as empty statistics", async () => {
    const { docker } = fakeDocker({ fail: SQL.read });
    const stats = await start(docker);
    expect(() => stats.read({ transactions: [], errors: [] })).toThrow(ServerStatsError);
  });
  it("sends nothing derived from the marker, database or results to the server", async () => {
    const hostile = "x'; drop table chunks; --";
    const { docker, calls } = fakeDocker({ marker: hostile });
    const stats = await start(docker, { marker: hostile });
    stats.reset();
    stats.read({ transactions: [], errors: [] });
    const inputs = psqlInputs(calls);
    expect(inputs.every((i) => Object.values(SQL).includes(i))).toBe(true);
    expect(inputs.join("\n")).not.toContain("drop table");
  });
  it("keeps the lock-wait offset when the container writes to stdout after the reset", async () => {
    let out = "entrypoint: init\n";
    let err = "LOG: process 1 still waiting for ShareLock on transaction 5 after 100.1 ms\n";
    const { docker } = fakeDocker();
    const wrapped = (args, opts) =>
      args[0] === "logs" ? { status: 0, stdout: out, stderr: err } : docker(args, opts);
    const stats = await start(wrapped);
    stats.reset();
    out += "a long late stdout message that would shift a combined offset\n";
    err += "LOG: process 2 still waiting for ShareLock on transaction 6 after 100.2 ms\n";
    expect(stats.read({ transactions: [], errors: [] }).lockWaits.count).toBe(1);
  });
  it("attributes waits to the scenario in which they were logged", async () => {
    let err = "";
    const { docker } = fakeDocker();
    const wrapped = (args, opts) =>
      args[0] === "logs" ? { status: 0, stdout: "", stderr: err } : docker(args, opts);
    const stats = await start(wrapped);
    stats.reset();
    err += "LOG: process 1 still waiting for ShareLock on transaction 5 after 100.1 ms\n";
    expect(stats.read({ transactions: [], errors: [] }).lockWaits.count).toBe(1);
    stats.reset();
    expect(stats.read({ transactions: [], errors: [] }).lockWaits.count).toBe(0);
  });
  it("reads statements longer than the classification window from both ends", () => {
    expect(SQL.read).toContain("length(c.q) <= 1200");
    expect(SQL.read).toContain("left(c.q, 600)");
    expect(SQL.read).toContain("right(c.q, 600)");
  });
});
