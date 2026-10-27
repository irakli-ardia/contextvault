#!/usr/bin/env node
// Keeps the public repository independent of local-only files:
//   - no tracked assistant/planning files, environment files (except .env.example and .env.test.example), or key material
//   - no tracked text file that refers to a local-only file
//
//   tracked-files.mjs [--root <dir>]
//
// Reads `git ls-files`, so it sees exactly what a clone would contain. No dependencies.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FORBIDDEN_PATH =
  /^context\/|(^|\/)(AGENTS\.md|CLAUDE\.md|memory\.md|PLAN\.md|\.claude\/|\.agents\/)|(^|\/)\.env(?!\.(test\.)?example$)[^/]*$|\.(pem|key)$/;
const LOCAL_REFERENCE = /(^|[^\w./-])(context\/|AGENTS\.md|CLAUDE\.md|PLAN\.md|memory\.md)/;
// This file names the patterns it enforces.
const REFERENCE_ALLOWLIST = new Set(["scripts/checks/tracked-files.mjs"]);

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
    text = readFileSync(join(root, file), "utf8");
  } catch {
    continue; // tracked but deleted in the working tree
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
