import { describe, expect, it } from "vitest";
import { SQL } from "./ingestion-bench-server-stats.mjs";
import {
  accepted,
  fakeDocker,
  inspected,
  psqlInputs,
  spec,
  start,
} from "./ingestion-bench-server-stats-support.mjs";
import { containerSpec, KEYWORD } from "./keyword-experiment-container.mjs";

describe("privileged channel", () => {
  it("verifies identity, installs in its own schema and addresses the container by id", async () => {
    const { docker, calls } = fakeDocker();
    const stats = await start(docker);
    expect(stats.metadata).toMatchObject({ enabled: true, extensionSchema: "bench_stats" });
    expect(psqlInputs(calls)).toEqual([SQL.marker, SQL.install, SQL.verify]);
    const exec = calls.find((c) => c.args[0] === "exec").args;
    expect(exec).toContain(accepted.Id);
    expect(exec).not.toContain(spec.name);
    expect(SQL.install).toBe(
      "create schema bench_stats;\ncreate extension pg_stat_statements with schema bench_stats;",
    );
    expect(SQL.install).not.toMatch(/grant|alter|role|policy/i);
  });
  it.each([
    ["another container id", { inspect: () => inspected({ Id: "b".repeat(64) }) }],
    ["another image id", { inspect: () => inspected({ Image: "sha256:other" }) }],
    ["a stopped container", { inspect: () => inspected({ State: { Running: false } }) }],
    [
      "a foreign run label",
      {
        inspect: () =>
          inspected({
            Config: {
              ...inspected().Config,
              Labels: { "cv.experiment": "ingestion-bench", "cv.experiment.run": "ffffffff" },
            },
          }),
      },
    ],
    [
      "a public port",
      {
        inspect: () =>
          inspected({
            NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "55123" }] } },
          }),
      },
    ],
    [
      "a keyword experiment container",
      {
        inspect: () =>
          inspected({
            Name: "/cv-kwexp-0a1b2c3d",
            Config: {
              ...inspected().Config,
              Labels: { "cv.experiment": "keyword-search", "cv.experiment.run": spec.id },
            },
          }),
      },
    ],
    [
      "another image",
      { inspect: () => inspected({ Config: { ...inspected().Config, Image: "postgres:latest" } }) },
    ],
  ])("refuses %s without running any privileged statement", async (_, over) => {
    const { docker, calls } = fakeDocker(over);
    await expect(start(docker)).rejects.toThrow(/refused/);
    expect(psqlInputs(calls)).toEqual([]);
  });
  it("reads only the identity marker from a database with a foreign marker, then stops", async () => {
    const { docker, calls } = fakeDocker({ marker: "someone-else" });
    await expect(start(docker)).rejects.toThrow("database identity marker");
    expect(psqlInputs(calls)).toEqual([SQL.marker]);
  });
  it("accepts the ingestion benchmark's own container", async () => {
    const { docker } = fakeDocker();
    await expect(start(docker)).resolves.toMatchObject({ metadata: { enabled: true } });
  });
  it("refuses a spec that is not the ingestion benchmark's, even if its container matches it", async () => {
    const keyword = containerSpec({ profile: KEYWORD, id: "0a1b2c3d" });
    const record = () =>
      inspected({
        Name: `/${keyword.name}`,
        Config: {
          Image: keyword.image,
          Env: [`POSTGRES_DB=${keyword.database}`],
          Labels: { "cv.experiment": "keyword-search", "cv.experiment.run": keyword.id },
        },
      });
    const { docker, calls } = fakeDocker({ inspect: record });
    await expect(start(docker, { spec: keyword })).rejects.toThrow("not an ingestion benchmark");
    expect(psqlInputs(calls)).toEqual([]);
  });
  it("refuses an inspect record that carries no container id", async () => {
    const { docker } = fakeDocker();
    await expect(start(docker, { accepted: { Image: "x" } })).rejects.toThrow("container id");
  });
  it("re-checks identity before every statement, so a replaced container stops the run", async () => {
    let swapped = false;
    const { docker, calls } = fakeDocker({
      inspect: () => inspected(swapped ? { Id: "c".repeat(64) } : {}),
    });
    const stats = await start(docker);
    swapped = true;
    const before = psqlInputs(calls).length;
    expect(() => stats.reset()).toThrow("container id");
    expect(psqlInputs(calls)).toHaveLength(before);
  });
});
