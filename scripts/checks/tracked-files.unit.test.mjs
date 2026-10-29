import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "tracked-files.mjs");
let dir;

function check(files, unstagedFix = {}) {
  dir = mkdtempSync(join(tmpdir(), "tracked-files-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  for (const [name, text] of Object.entries(unstagedFix)) writeFileSync(join(dir, name), text);
  return spawnSync("node", [script, "--root", dir], { encoding: "utf8" });
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tracked-files", () => {
  it("accepts ordinary public files", () => {
    const result = check({
      "README.md": "hello\n",
      "docs/setup.md": "steps\n",
      ".env.example": "",
    });
    expect(result.status).toBe(0);
  });

  it.each([
    "AGENTS.md",
    "apps/web/AGENTS.md",
    ".claude/settings.json",
    ".codex/hooks.json",
    ".agents/README.md",
    "context/plan.md",
    "docs/archive/brief.md",
    "docs/README.md",
    "scripts/skills/index.mjs",
    "scripts/checks/agent-stop.mjs",
    ".project-setup/state.json",
    "session-logs/a.md",
    "run.session.log",
    ".env",
  ])("rejects %s", (file) => {
    const result = check({ [file]: "x\n" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(file);
  });

  it("rejects a public file that points at a local-only file", () => {
    const result = check({ "docs/setup.md": "see context/plan.md\n" });
    expect(result.status).toBe(1);
  });

  it("checks the staged content, not the working tree", () => {
    const result = check({ "docs/setup.md": "see context/plan.md\n" }, { "docs/setup.md": "ok\n" });
    expect(result.status).toBe(1);
  });
});
