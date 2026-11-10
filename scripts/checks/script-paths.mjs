// Rules behind script-paths.unit.test.mjs (see there for the contract): literal `scripts/….mjs`
// references must exist in the working tree, and `scripts/` files must sit in owned directories.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

export const OWNED_DIRS = ["bench", "checks", "git", "infra", "launcher", "test-stack"];
const SKIPPED_FILES = new Set([
  "scripts/checks/script-paths.mjs",
  "scripts/checks/script-paths.unit.test.mjs",
  "pnpm-lock.yaml",
]);

// A `../` prefix is relative to the directory the command runs in: the file's own directory unless
// listed here. Playwright starts the web server in apps/web, and the dev loop runs from the app
// directory (apps/api and apps/worker are the same depth). Update a key when its file moves; a
// stale key fails.
export const CALLER_DIR = {
  "playwright.config.ts": "apps/web",
  "scripts/test-stack/playwright-config.unit.test.mjs": "apps/web",
  "scripts/launcher/dev.mjs": "apps/api",
};

// Script names a test invents inside a temporary tree, keyed by the only files allowed to name
// them. Everywhere else the name is an ordinary reference. Update a key when its file moves; a
// stale key, or a name its file no longer contains, fails.
export const FIXTURES = {
  "scripts/checks/structure-check.unit.test.mjs": ["scripts/utils.mjs"],
  "scripts/checks/tracked-files.unit.test.mjs": [
    "scripts/skills/index.mjs",
    "scripts/checks/agent-stop.mjs",
  ],
};

const REF = /(?<![\w./-])((?:\.\.\/)*)(scripts\/[\w./-]*[\w-]\.mjs)(?![\w-])/g;

export function listFiles(root) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file && existsSync(join(root, file))); // a moved file stays in the index until staged
}

export function readText(root, file) {
  const bytes = readFileSync(join(root, file));
  return bytes.includes(0) ? "" : bytes.toString("utf8");
}

export function referenceProblems(files, read) {
  const present = new Set(files);
  const problems = [];
  for (const file of files) {
    if (SKIPPED_FILES.has(file)) continue;
    const text = read(file);
    for (const match of text.matchAll(REF)) {
      const [whole, prefix, target] = match;
      if (FIXTURES[file]?.includes(target)) continue;
      const resolved = prefix
        ? posix.join(CALLER_DIR[file] ?? posix.dirname(file), prefix, target)
        : target;
      if (present.has(resolved)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(`${file}:${line}: ${whole} resolves to ${resolved}, which does not exist`);
    }
  }
  return problems;
}

export function exemptionProblems(files, read) {
  const present = new Set(files);
  const problems = [];
  for (const file of [...Object.keys(CALLER_DIR), ...Object.keys(FIXTURES)]) {
    if (!present.has(file)) problems.push(`${file}: stale exemption key, the file is gone`);
  }
  for (const [file, names] of Object.entries(FIXTURES)) {
    if (!present.has(file)) continue;
    const text = read(file);
    for (const name of names) {
      if (!text.includes(name))
        problems.push(`${file}: no longer names ${name}, drop the exemption`);
    }
  }
  return problems;
}

export function ownershipProblems(files) {
  const problems = [];
  for (const file of files) {
    const [top, dir, rest] = file.split("/");
    if (top !== "scripts") continue;
    if (rest === undefined) {
      problems.push(`${file}: no root-level scripts; use ${OWNED_DIRS.join(", ")}`);
    } else if (rest !== undefined && !OWNED_DIRS.includes(dir)) {
      problems.push(`${file}: unapproved scripts/ directory "${dir}"`);
    }
  }
  return problems;
}

export function scan(root) {
  const files = listFiles(root);
  return [...ownershipProblems(files), ...referenceProblems(files, (file) => readText(root, file))];
}
