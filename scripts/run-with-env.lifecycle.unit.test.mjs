import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Process lifecycle of run-with-env.mjs and dev.mjs: copies of both scripts in a temp tree, run
// over infra-free probes (no API, worker, database or network). The launcher execs into the entry,
// so a probe is the launcher's own process. Env and contract tests are in run-with-env.unit.test.mjs.
const BASE = { PATH: "/usr/bin" };
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

let root;
let probe;
let rebuild;
let appDir;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "run-with-env-lifecycle-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./run-with-env.mjs", import.meta.url), join(root, "scripts/launcher.mjs"));
  probe = join(root, "probe.mjs");
  // `wait` announces its pid and idles until a signal ends it. `once <signal>` does the same but
  // closes gracefully (exit 0, reported as "exited 0") on the first such signal; a second one finds
  // no handler and kills it. Every probe ends by itself after 20 s, so a failed test leaks nothing.
  writeFileSync(
    probe,
    `import { writeSync } from "node:fs";
const [mode, arg] = process.argv.slice(2);
if (mode === "once") process.once(arg, () => { console.log("closing"); setTimeout(() => process.exit(0), 250); });
process.on("exit", (code) => writeSync(1, "exited " + code + "\\n")); // not emitted when a signal kills it
console.log("ready " + process.pid);
setTimeout(() => process.exit(1), 20000);
`,
  );

  // What tsdown does on a rebuild (executeOnSuccess): run the command in a shell, and on abort
  // tree-kill it, which signals every descendant by parent pid. "rebuild" on stdin is the abort.
  rebuild = join(root, "rebuild.mjs");
  writeFileSync(
    rebuild,
    `import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const [command, treeKillPath] = process.argv.slice(2);
const treeKill = createRequire(import.meta.url)(treeKillPath);
const child = spawn(command, { shell: true, stdio: "inherit" });
process.stdin.once("data", () => treeKill(child.pid));
child.on("exit", () => process.exit(0));
setTimeout(() => process.exit(1), 20000);
`,
  );

  // dev.mjs with a fake tsdown that, like the real one, dies on SIGTERM without stopping the entry
  // it started. dist/main.mjs closes gracefully on the first SIGTERM only.
  const tree = join(root, "dev");
  appDir = join(tree, "apps/api");
  mkdirSync(join(tree, "scripts"), { recursive: true });
  mkdirSync(join(appDir, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(appDir, "dist"));
  for (const file of ["dev.mjs", "run-with-env.mjs"]) {
    copyFileSync(new URL(`./${file}`, import.meta.url), join(tree, "scripts", file));
  }
  const tsdown = join(appDir, "node_modules/.bin/tsdown");
  writeFileSync(
    tsdown,
    `#!${process.execPath}
import { spawn } from "node:child_process";
spawn(process.argv[process.argv.indexOf("--on-success") + 1], { shell: true, stdio: "inherit" });
process.on("SIGTERM", () => process.exit(143));
setTimeout(() => process.exit(1), 20000); // safety net if a test dies half way
`,
  );
  chmodSync(tsdown, 0o755);
  writeFileSync(
    join(appDir, "dist/main.mjs"),
    `import { writeSync } from "node:fs";
process.once("SIGTERM", () => { console.log("closing"); setTimeout(() => process.exit(0), 250); });
process.on("exit", (code) => writeSync(1, "exited " + code + "\\n")); // not emitted when a signal kills it
console.log("ready " + process.pid);
setTimeout(() => process.exit(1), 20000);
`,
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const expectGone = (pid) =>
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const count = (text, word) => text.split(word).length - 1;
// A process can exit between a liveness check and the kill; only that case (ESRCH) is ignored.
const kill = (pid, signal) => {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const running = (child) => child.exitCode === null && child.signalCode === null;

// Collects a child's stdout. `until(test)` resolves with the first non-undefined result of
// `test(output)` and rejects, showing the output so far, if the child ends first.
const watch = (child) => {
  let out = "";
  const checks = new Set();
  const exited = new Promise((resolve) => child.on("close", (code, sig) => resolve({ code, sig })));
  child.stdout.on("data", (chunk) => {
    out += chunk;
    for (const check of checks) check();
  });
  const until = (test) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const value = test(out);
        if (value !== undefined) resolve(value);
      };
      checks.add(check);
      check();
      void exited.then(() => reject(new Error(`ended early; output: ${JSON.stringify(out)}`)));
    });
  // The newline matters: a chunk can end mid-number ("ready 12" of "ready 1234").
  const pids = () => [...out.matchAll(/ready (\d+)\n/g)].map((match) => Number(match[1]));
  return { child, exited, until, pids, output: () => out, ready: () => until(() => pids()[0]) };
};

// Runs `body` over a watched child, then SIGKILLs the child (its whole group if it leads one) and
// every probe that reported ready, pass or fail, so a failing assertion leaves no process behind.
const supervise = async (child, group, body) => {
  const watched = watch(child);
  try {
    return await body(watched);
  } finally {
    for (const pid of watched.pids()) if (alive(pid)) kill(pid, "SIGKILL");
    if (running(child)) kill(group ? -child.pid : child.pid, "SIGKILL");
  }
};

// The launcher as its own process group leader (as tsdown's group is in dev.mjs) over a probe.
const withLauncher = (app, probeArgs, body) =>
  supervise(
    spawn(process.execPath, [join(root, "scripts/launcher.mjs"), app, probe, ...probeArgs], {
      env: BASE,
      stdio: ["ignore", "pipe", "inherit"],
      detached: true,
    }),
    true,
    async (watched) => body({ ...watched, pid: await watched.ready() }),
  );

describe("launcher", () => {
  it("is replaced by the entry, which keeps the pid", () =>
    withLauncher("api", ["wait"], async ({ child, pid }) => {
      expect(pid).toBe(child.pid);
    }));

  it.each(SIGNALS)("%s ends an entry without a handler, by that signal", (signal) =>
    withLauncher("api", ["wait"], async ({ child, exited, pid }) => {
      child.kill(signal);
      expect(await exited).toEqual({ code: null, sig: signal });
      expectGone(pid);
    }),
  );

  // dev.mjs signals the whole process group; the entry must see the signal once. Its 250 ms close
  // window only bounds how long a duplicate can take to arrive: waiting longer can hide a
  // duplicate, never invent one.
  it.each(SIGNALS)("a group-delivered %s reaches the entry once and it exits 0", (signal) =>
    withLauncher("api", ["once", signal], async ({ child, exited, pid, output }) => {
      process.kill(-child.pid, signal);
      expect(await exited).toEqual({ code: 0, sig: null });
      expect(count(output(), "closing")).toBe(1);
      expectGone(pid);
    }),
  );

  it("lets a worker entry finish its own graceful shutdown and exit 0", () =>
    withLauncher("worker", ["once", "SIGTERM"], async ({ child, exited, pid, output }) => {
      child.kill("SIGTERM");
      expect(await exited).toEqual({ code: 0, sig: null });
      expect(count(output(), "closing")).toBe(1);
      expect(output()).toContain("exited 0");
      expectGone(pid);
    }));

  // infra-smoke SIGKILLs the pid it spawned when the worker is not ready in time: with no wrapper
  // that pid is the worker, so nothing is left running.
  it("SIGKILL of the spawned pid stops the entry itself", () =>
    withLauncher("worker", ["wait"], async ({ child, exited, pid }) => {
      child.kill("SIGKILL");
      expect(await exited).toEqual({ code: null, sig: "SIGKILL" });
      expectGone(pid);
    }));

  // tsdown tree-kills the on-success command on every rebuild, signalling every descendant by
  // parent pid; the entry must still see one SIGTERM and finish closing.
  it("a tsdown rebuild gives a once-only entry one SIGTERM and it exits 0", async () => {
    const tsdown = createRequire(new URL("../apps/api/", import.meta.url)).resolve("tsdown");
    const treeKill = createRequire(tsdown).resolve("tree-kill");
    const command = `${process.execPath} ${join(root, "scripts/launcher.mjs")} worker ${probe} once SIGTERM`;
    const harness = spawn(process.execPath, [rebuild, command, treeKill], {
      env: BASE,
      stdio: ["pipe", "pipe", "inherit"],
    });
    await supervise(harness, false, async ({ exited, ready, output }) => {
      const pid = await ready();
      harness.stdin.write("rebuild\n");
      await exited;
      expect(count(output(), "closing")).toBe(1);
      expect(output()).toContain("exited 0");
      expectGone(pid);
    });
  });
});

describe("dev loop", () => {
  const dev = (app) => [join(root, "dev/scripts/dev.mjs"), app];
  const waitGone = async (pid) => {
    for (let i = 0; i < 250 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
    expectGone(pid);
  };

  it("runs the entry through the launcher and stops it gracefully, once, on SIGTERM", async () => {
    const loop = spawn(process.execPath, dev("api"), {
      cwd: appDir,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin` },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await supervise(loop, false, async ({ exited, ready, output }) => {
      const pid = await ready();
      loop.kill("SIGTERM");
      // dev.mjs passes on the loop's own status (the fake tsdown exits 143 on SIGTERM); "close"
      // also waits for the entry to release the shared stdout pipe, i.e. to be gone.
      expect(await exited).toEqual({ code: 143, sig: null });
      expect(count(output(), "closing")).toBe(1);
      expect(output()).toContain("exited 0");
      await waitGone(pid);
    });
  });

  it("refuses an unknown app with status 2", () => {
    const run = spawnSync(process.execPath, dev("web"), { cwd: appDir, env: BASE });
    expect(run.status).toBe(2);
  });
});
