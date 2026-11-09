import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

// A stub `docker` logs each call and reports a lingering container, so main() refuses to start with
// a known message. That proves whether main() ran, and how often, without Docker or PostgreSQL.
const script = fileURLToPath(new URL("./orphan-clustered.mjs", import.meta.url));
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cv-bench-entry-"));
  writeFileSync(
    join(dir, "docker"),
    `#!/bin/sh\necho "$@" >> "${dir}/calls"\necho cv-bench-orphan-stub\n`,
  );
  chmodSync(join(dir, "docker"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const calls = () => {
  try {
    return readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
};
const node = (args, cwd) =>
  spawnSync(process.execPath, args, { encoding: "utf8", env: { PATH: dir }, cwd });

function expectRanOnce(run) {
  expect(run.stderr).toContain("refusing to start: cv-bench-orphan-stub exists");
  expect(run.status).not.toBe(0);
  expect(calls()).toHaveLength(1);
}

it("runs main() once for an absolute path", () => expectRanOnce(node([script])));

it("runs main() once for a relative path", () =>
  expectRanOnce(node([script.split("/").at(-1)], dirname(script))));

it("runs main() once through a symlink", () => {
  const link = join(dir, "link.mjs");
  symlinkSync(script, link);
  expectRanOnce(node([link]));
});

it("does not run main() when imported", () => {
  const importer = join(dir, "importer.mjs");
  writeFileSync(
    importer,
    `const m = await import(${JSON.stringify(pathToFileURL(script).href)});\nconsole.log(typeof m.main);\n`,
  );
  const run = node([importer]);
  expect(run.stdout.trim()).toBe("function");
  expect(run.status).toBe(0);
  expect(calls()).toEqual([]);
});
