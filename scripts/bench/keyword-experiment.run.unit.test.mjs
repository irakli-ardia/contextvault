import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./keyword-experiment.mjs";
import { writeOnce } from "./keyword-experiment-args.mjs";
import { CheckFailure } from "./keyword-experiment-checks.mjs";

const env = { DOCKER_HOST: "unix:///var/run/docker.sock" };
const GONE = { status: 1, stdout: "", stderr: "Error: No such container" };

describe("run: publishing, cleanup and exit status", () => {
  let dir;
  let out;
  let calls;
  const docker = (args) => {
    calls.push(args);
    return GONE;
  };
  const removed = () => calls.some((a) => a[0] === "rm" && a.includes("-f"));
  const engine = (experiment, write = writeOnce) => ({
    load: async () => ({}),
    prepare: async () => ({}),
    experiment,
    write,
  });
  const execute = (options) =>
    main(["run", "--execute", "--chunks=1000", `--out=${out}`], {
      docker,
      log: () => {},
      env,
      engine: options,
    });
  const noLink = () => {
    throw Object.assign(new Error("link"), { code: "EPERM" });
  };
  const written = () => JSON.parse(readFileSync(out, "utf8"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kwexp-run-"));
    out = join(dir, "r.json");
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a successful run publishes a complete result and removes the container", async () => {
    await execute(engine(async () => {}));
    expect(written()).toMatchObject({ completion: "complete", containerRemoved: true });
    expect(removed()).toBe(true);
  });

  it("a successful run whose result cannot be published fails, keeps the full temp file and cleans up", async () => {
    const write = (path, text) => writeOnce(path, text, { link: noLink });
    await expect(execute(engine(async () => {}, write))).rejects.toThrow(
      /result not published, kept at .*\.tmp: EPERM/,
    );
    const temp = `${out}.${process.pid}.tmp`;
    expect(existsSync(out)).toBe(false);
    expect(JSON.parse(readFileSync(temp, "utf8"))).toMatchObject({ completion: "complete" });
    expect(removed()).toBe(true);
  });

  it("never overwrites a file that appears while the experiment runs", async () => {
    const experiment = async () => writeFileSync(out, "someone else");
    await expect(execute(engine(experiment))).rejects.toThrow(/result not published/);
    expect(readFileSync(out, "utf8")).toBe("someone else");
    expect(JSON.parse(readFileSync(`${out}.${process.pid}.tmp`, "utf8")).completion).toBe(
      "complete",
    );
    expect(removed()).toBe(true);
  });

  it("a failed check is written as checks-failed, removes the container and fails the run", async () => {
    const experiment = async (_prepared, { state }) => {
      state.variants.push({ key: "stored", complete: true, cases: [] });
      throw new CheckFailure("stored: tenant isolation failed");
    };
    await expect(execute(engine(experiment))).rejects.toThrow(/tenant isolation failed/);
    expect(written()).toMatchObject({
      completion: "checks-failed",
      error: "stored: tenant isolation failed",
      containerRemoved: true,
      variants: [{ key: "stored", complete: true }],
    });
    expect(removed()).toBe(true);
  });

  it("an ordinary failure stays partial and still fails the run", async () => {
    await expect(
      execute(
        engine(async () => {
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");
    expect(written()).toMatchObject({ completion: "partial", error: "boom" });
  });

  it("reports both a failed run and a failed publish, and still removes the container", async () => {
    const experiment = async () => {
      throw new Error("boom");
    };
    const write = (path, text) => writeOnce(path, text, { link: noLink });
    const failure = await execute(engine(experiment, write)).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toMatch(/kept at .*the run also failed: boom/);
    expect(existsSync(`${out}.${process.pid}.tmp`)).toBe(true);
    expect(removed()).toBe(true);
  });
  describe("when the container cannot be confirmed removed", () => {
    const STUCK = { status: 0, stdout: "", stderr: "" }; // inspect still finds it
    const boom = async () => {
      throw new Error("boom");
    };
    const failingLink = (path, text) => writeOnce(path, text, { link: noLink });
    const stuck = (args) => {
      calls.push(args);
      return args[0] === "inspect" ? STUCK : { status: 1, stdout: "", stderr: "rm failed" };
    };
    const executeStuck = (experiment, write) =>
      main(["run", "--execute", "--chunks=1000", `--out=${out}`], {
        docker: stuck,
        log: logs.push.bind(logs),
        env,
        engine: engine(experiment, write),
      });
    let logs;
    beforeEach(() => {
      logs = [];
    });

    it("a successful run fails, names cleanup and keeps the result", async () => {
      await expect(executeStuck(async () => {})).rejects.toThrow(/may still exist.*run cleanup/);
      expect(written()).toMatchObject({ completion: "complete", containerRemoved: false });
      expect(written().removalDetail).toMatch(/still present/);
      expect(logs.join("\n")).toMatch(/not removed .*cleanup/);
    });

    it("a failed run reports both failures", async () => {
      const failure = await executeStuck(boom).catch((error) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.message).toMatch(/^boom; container .*may still exist/);
      expect(failure.errors).toHaveLength(2);
      expect(written()).toMatchObject({ completion: "partial", containerRemoved: false });
    });

    it("a failed publish reports both failures and keeps the temp file", async () => {
      const failure = await executeStuck(async () => {}, failingLink).catch((error) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.message).toMatch(/result not published.*may still exist/);
      expect(JSON.parse(readFileSync(`${out}.${process.pid}.tmp`, "utf8"))).toMatchObject({
        containerRemoved: false,
      });
    });

    it("a failed run and publish and removal are all kept", async () => {
      const failure = await executeStuck(boom, failingLink).catch((error) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors).toHaveLength(3);
      expect(failure.message).toMatch(/not published.*the run also failed: boom.*may still exist/);
    });

    it("a docker that cannot be run counts as not removed", async () => {
      const broken = () => {
        throw new Error("spawn docker ENOENT");
      };
      const failure = await main(["run", "--execute", "--chunks=1000", `--out=${out}`], {
        docker: broken,
        log: () => {},
        env,
        engine: engine(async () => {}),
      }).catch((error) => error);
      expect(failure.message).toMatch(/may still exist \(spawn docker ENOENT\)/);
    });
  });

  describe("signals", () => {
    let exit;
    beforeEach(() => {
      exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);
    });
    afterEach(() => exit.mockRestore());

    it("keeps the handlers installed while the container is removed", async () => {
      const seen = [];
      const watching = (args) => {
        if (args[0] === "rm") seen.push(process.listenerCount("SIGINT"));
        return GONE;
      };
      const before = process.listenerCount("SIGINT");
      await main(["run", "--execute", "--chunks=1000", `--out=${out}`], {
        docker: watching,
        log: () => {},
        env,
        engine: engine(async () => {}),
      });
      expect(seen[0]).toBe(before + 1);
      expect(process.listenerCount("SIGINT")).toBe(before);
    });

    it("finalises once on a signal, records it and exits with its code", async () => {
      const experiment = async () => {
        process.emit("SIGTERM");
        process.emit("SIGINT");
      };
      await execute(engine(experiment));
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(143);
      expect(written()).toMatchObject({ completion: "interrupted", interruptedBy: "SIGTERM" });
      expect(calls.filter((a) => a[0] === "rm")).toHaveLength(1);
    });
  });
});
