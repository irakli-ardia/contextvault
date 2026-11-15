import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "./keyword-experiment.mjs";

/** A docker that fails the test if anything beyond the named calls is attempted. */
const recording = (answer = { status: 0, stdout: "", stderr: "" }) => {
  const calls = [];
  const docker = (args) => {
    calls.push(args);
    return answer;
  };
  return { calls, docker };
};
const logs = () => {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(" ")) };
};

describe("main safety gates", () => {
  it("plan starts nothing and never calls docker", async () => {
    const { calls, docker } = recording();
    const { lines, log } = logs();
    await main([], { docker, log, env: {} });
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toMatch(/plan only: nothing was started/);
  });

  it("run without --execute starts nothing and never calls docker", async () => {
    const { calls, docker } = recording();
    const { lines, log } = logs();
    await main(["run"], { docker, log, env: {} });
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toMatch(/run needs --execute: nothing was started/);
  });

  it("run --execute against a remote daemon stops before any container command", async () => {
    const { calls, docker } = recording();
    await expect(
      main(["run", "--execute"], {
        docker,
        log: () => {},
        env: { DOCKER_HOST: "tcp://10.0.0.5:2375" },
      }),
    ).rejects.toThrow(/refused/);
    expect(calls).toEqual([]);
  });

  const local = { DOCKER_HOST: "unix:///var/run/docker.sock" };

  it("run --execute refuses a bad or existing output file before any container exists", async () => {
    const { calls, docker } = recording();
    const dir = mkdtempSync(join(tmpdir(), "kwexp-main-"));
    try {
      const existing = join(dir, "r.json");
      writeFileSync(existing, "keep");
      for (const [out, message] of [
        [join(dir, "r.txt"), /\.json/],
        [existing, /already exists/],
        [join(dir, "missing", "r.json"), /directory/],
      ]) {
        await expect(
          main(["run", "--execute", "--chunks=1000", `--out=${out}`], {
            docker,
            log: () => {},
            env: local,
          }),
        ).rejects.toThrow(message);
      }
      expect(readFileSync(existing, "utf8")).toBe("keep");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(calls).toEqual([]);
  });

  it("run --execute of a size other than 50000 chunks needs --out, before any container exists", async () => {
    const { calls, docker } = recording();
    await expect(
      main(["run", "--execute", "--chunks=1000"], { docker, log: () => {}, env: local }),
    ).rejects.toThrow(/--out/);
    expect(calls).toEqual([]);
  });

  it("cleanup refuses a remote daemon as well", async () => {
    const { calls, docker } = recording();
    await expect(
      main(["cleanup"], { docker, log: () => {}, env: { DOCKER_HOST: "ssh://h" } }),
    ).rejects.toThrow(/refused/);
    expect(calls).toEqual([]);
  });

  it("rejects malformed arguments before anything else", async () => {
    const { calls, docker } = recording();
    await expect(main(["run", "--execute", "--out=a=b"], { docker, env: {} })).rejects.toThrow(
      /without '='/,
    );
    expect(calls).toEqual([]);
  });
});
