#!/usr/bin/env node
// Keeps the public repository independent of local-only files:
//   - no tracked assistant/planning files, environment files (except .env.example and .env.test.example), or key material
//   - no tracked text file that refers to a local-only file
//
//   tracked-files.mjs [--root <dir>]
//
// Reads `git ls-files`, so it sees exactly what a clone would contain. No dependencies.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const FORBIDDEN_PATH =
  /^(context|docs\/archive|scripts\/skills)\/|^docs\/README\.md$|^scripts\/checks\/agent-stop\.mjs$|(^|\/)(AGENTS\.md|CLAUDE\.md|memory\.md|PLAN\.md|\.claude\/|\.codex\/|\.agents\/|\.project-setup\/|session-logs\/)|\.session\.log$|(^|\/)\.env(?!\.(test\.)?example$)[^/]*$|\.(pem|key)$/;
const LOCAL_REFERENCE = /(^|[^\w./-])(context\/|AGENTS\.md|CLAUDE\.md|PLAN\.md|memory\.md)/;
// These files name the patterns they enforce.
const REFERENCE_ALLOWLIST = new Set([
  "scripts/checks/tracked-files.mjs",
  "scripts/checks/tracked-files.unit.test.mjs",
]);

const rootFlag = process.argv.indexOf("--root");
const root = resolve(rootFlag === -1 ? process.cwd() : (process.argv[rootFlag + 1] ?? "."));
const tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const problems = [];
for (const file of tracked) {
  if (FORBIDDEN_PATH.test(file)) problems.push(`${file}: local-only or sensitive file is tracked`);
  if (REFERENCE_ALLOWLIST.has(file)) continue;
  let text;
  try {
    // The staged blob, not the working tree: a commit contains the index.
    text = execFileSync("git", ["-C", root, "show", `:${file}`], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  } catch {
    continue; // not a readable blob (for example a submodule)
  }
  if (text.includes("\0")) continue;
  const lines = text.split("\n");
  const index = lines.findIndex((line) => LOCAL_REFERENCE.test(line));
  if (index !== -1) problems.push(`${file}:${index + 1}: refers to a local-only file`);
}

if (problems.length > 0) {
  console.error(`tracked-files: ${problems.length} problem(s)\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`tracked-files: ${tracked.length} tracked files ok`);
