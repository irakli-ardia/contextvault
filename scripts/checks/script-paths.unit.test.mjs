// Keeps `scripts/` paths honest while files move (Slice 6): every literal `scripts/….mjs` named by a
// config, hook, workflow, doc or source comment must exist in the working tree, and every file
// under `scripts/` must sit in an approved directory.
//
// Existence is the working tree (tracked and untracked, minus ignored), so a destination created by
// a move counts before it is staged, while an ignored local file cannot hide a path that CI lacks.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CALLER_DIR,
  exemptionProblems,
  FIXTURES,
  listFiles,
  OWNED_DIRS,
  ownershipProblems,
  readText,
  referenceProblems,
  scan,
} from "./script-paths.mjs";

const repo = join(import.meta.dirname, "..", "..");

// Root-level scripts still waiting for their move (6d test-stack). 6d deletes its entry and
// lowers CEILING in the same change: the size must equal
// CEILING, so a removal that leaves CEILING behind fails, and a stale entry fails. The list, CEILING
// and this exception are deleted after 6d. Known limit: swapping an entry for a new root-level name
// at the same size passes here; review catches it, the original six are the ones listed below.
const CEILING = 1;
const ROOT_LEGACY = new Set(["scripts/playwright-config.unit.test.mjs"]);

const refs = (tree) => referenceProblems(Object.keys(tree), (file) => tree[file]);

describe("script paths in this repository", () => {
  it("every referenced script exists and every script sits in an approved directory", () => {
    expect(scan(repo, ROOT_LEGACY)).toEqual([]);
  });

  it("scans the hooks, workflows and package scripts", () => {
    const files = listFiles(repo);
    for (const file of [".githooks/pre-push", ".github/workflows/ci.yml", "package.json"]) {
      expect(files).toContain(file);
    }
  });

  it("pins the root-level allowlist: root files only, size exactly CEILING", () => {
    expect(ROOT_LEGACY.size).toBe(CEILING);
    for (const entry of ROOT_LEGACY) expect(entry).toMatch(/^scripts\/[^/]+$/);
  });

  it("has no stale CALLER_DIR or FIXTURES exemption", () => {
    const files = listFiles(repo);
    expect(exemptionProblems(files, (file) => readText(repo, file))).toEqual([]);
  });
});

describe("script references", () => {
  const real = {
    "scripts/launcher/dev.mjs": "",
    "scripts/launcher/run-with-env.mjs": "",
    "scripts/checks/docs-check.mjs": "",
  };

  it.each([
    [".github/workflows/ci.yml", "run: node scripts/checks/docs-check.mjs"],
    [".githooks/pre-push", "node scripts/checks/docs-check.mjs || exit 1"],
    ["apps/api/package.json", '"dev": "node ../../scripts/launcher/dev.mjs api"'],
    ["playwright.config.ts", "node ../../scripts/launcher/dev.mjs web"],
    ["docs/setup.md", "[dev](../scripts/launcher/dev.mjs)"],
    ["vitest.config.ts", 'include: ["scripts/**/*.unit.test.mjs"]'],
    ["tracked.mjs", "/^scripts\\/checks\\/gone\\.mjs$/"],
    [
      "README.md",
      "scripts/bench/ scripts/checks/gone.sh scripts/gone.mjsx vendor/scripts/gone.mjs",
    ],
  ])("accepts %s: %s", (file, text) => {
    expect(refs({ ...real, [file]: text })).toEqual([]);
  });

  it.each([
    [
      "a stale path",
      "README.md",
      "run scripts/checks/gone.mjs",
      "README.md:1: scripts/checks/gone.mjs",
    ],
    [
      "the old location",
      "package.json",
      "\n\nnode scripts/docs-check.mjs",
      "package.json:3: scripts/docs-check.mjs",
    ],
    [
      "a wrong relative path",
      "apps/api/package.json",
      "node ../scripts/launcher/dev.mjs",
      "resolves to apps/scripts/launcher/dev.mjs",
    ],
    [
      "a path leaving the repository",
      "docs/setup.md",
      "[d](../../scripts/launcher/dev.mjs)",
      "resolves to ../scripts/launcher/dev.mjs",
    ],
    [
      "Playwright path from the root",
      "playwright.config.ts",
      "x\nnode ../scripts/launcher/dev.mjs",
      "playwright.config.ts:2",
    ],
    ["a hook", ".githooks/pre-push", "\nnode scripts/git/gone.mjs", ".githooks/pre-push:2"],
  ])("rejects %s", (_name, file, text, message) => {
    const problems = refs({ ...real, [file]: text });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(message);
  });

  it.each([
    ["scripts/utils.mjs", "scripts/checks/structure-check.unit.test.mjs"],
    ["scripts/skills/index.mjs", "scripts/checks/tracked-files.unit.test.mjs"],
  ])("skips %s only in %s", (name, owner) => {
    expect(refs({ [owner]: name })).toEqual([]);
    expect(refs({ "README.md": name, "scripts/checks/other.unit.test.mjs": name })).toHaveLength(2);
    expect(refs({ [owner]: `${name} scripts/checks/gone.mjs` })).toHaveLength(1);
    expect(Object.keys(FIXTURES)).toContain(owner);
  });

  it("flags a stale exemption: a missing key file or a name the file dropped", () => {
    const owner = "scripts/checks/structure-check.unit.test.mjs";
    const keys = [...Object.keys(CALLER_DIR), ...Object.keys(FIXTURES)];
    const stale = exemptionProblems([], () => "");
    expect(stale).toHaveLength(keys.length);
    expect(stale.every((problem) => problem.includes("stale exemption key"))).toBe(true);
    expect(exemptionProblems(keys, () => "")).toContainEqual(
      `${owner}: no longer names scripts/utils.mjs, drop the exemption`,
    );
    expect(
      exemptionProblems(keys, (file) =>
        file === owner
          ? "scripts/utils.mjs"
          : "scripts/skills/index.mjs scripts/checks/agent-stop.mjs",
      ),
    ).toEqual([]);
  });

  it("resolves the dev loop's path from the app directory, so a move that forgets it fails", () => {
    const dev = { "scripts/launcher/dev.mjs": "node ../../scripts/launcher/run-with-env.mjs" };
    expect(refs({ ...dev, "scripts/launcher/run-with-env.mjs": "" })).toEqual([]);
    expect(refs({ ...dev, "scripts/run-with-env.mjs": "" })).toHaveLength(1);
  });
});

describe("script directory ownership", () => {
  const own = (files, legacy = new Set()) => ownershipProblems(files, legacy);

  it.each(OWNED_DIRS)("accepts scripts/%s, nested or not", (dir) => {
    expect(own([`scripts/${dir}/a.mjs`, `scripts/${dir}/deep/b.mjs`])).toEqual([]);
  });

  it("ignores files outside scripts/", () => {
    expect(own(["apps/api/scripts/x.mjs", "scripts.md", "docs/scripts/x.mjs"])).toEqual([]);
  });

  it("rejects a new root-level script and an unapproved directory", () => {
    const legacy = [...ROOT_LEGACY];
    expect(own(["scripts/new.mjs", ...legacy], ROOT_LEGACY)).toEqual([
      expect.stringContaining("scripts/new.mjs: no new root-level scripts"),
    ]);
    expect(own(["scripts/misc/a.mjs", "scripts/Checks/a.mjs"])).toHaveLength(2);
  });

  it("fails a stale allowlist entry once its file moved", () => {
    const files = [...ROOT_LEGACY].filter(
      (file) => file !== "scripts/playwright-config.unit.test.mjs",
    );
    expect(
      own([...files, "scripts/test-stack/playwright-config.unit.test.mjs"], ROOT_LEGACY),
    ).toEqual(["scripts/playwright-config.unit.test.mjs: stale ROOT_LEGACY entry, remove it"]);
  });
});

describe("working-tree existence", () => {
  let dir;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function repoWith(files, exclude = "") {
    dir = mkdtempSync(join(tmpdir(), "script-paths-"));
    execFileSync("git", ["-C", dir, "init", "-q"]);
    writeFileSync(join(dir, ".git/info/exclude"), exclude);
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  }

  it("counts an untracked destination created by a move", () => {
    const root = repoWith({ "README.md": "scripts/infra/new.mjs", "scripts/infra/new.mjs": "" });
    expect(scan(root, new Set())).toEqual([]);
  });

  it("does not count an ignored file, which CI would not have", () => {
    const root = repoWith(
      { "README.md": "scripts/infra/local.mjs", "scripts/infra/local.mjs": "" },
      "scripts/infra/local.mjs\n",
    );
    expect(scan(root, new Set())).toEqual([expect.stringContaining("README.md:1:")]);
  });

  it("does not count a file removed from disk but still in the index", () => {
    const root = repoWith({ "README.md": "scripts/checks/old.mjs", "scripts/checks/old.mjs": "" });
    execFileSync("git", ["-C", root, "add", "-A"]);
    rmSync(join(root, "scripts/checks/old.mjs"));
    expect(scan(root, new Set())).toEqual([expect.stringContaining("README.md:1:")]);
  });
});
