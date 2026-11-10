#!/usr/bin/env node
// Deterministic file-placement rules (see docs/engineering-standards.md, "Repository structure"):
//   1. an `*.integration.test.ts` file sits under an `integration/` directory that a feature owns:
//      `<feature>/integration/…`, or `src/integration/<area>/…` (never directly in `src/integration/`)
//   2. integration tests use the `.ts` extension, the only one the integration project discovers
//   3. no file or directory is named utils, helpers, common, misc, manager or shared
//   4. at least one source file is scanned, so a wrong root cannot pass silently
//   5. an `integration/` file imports only its own area's files or files outside any integration
//      area (shared support belongs in the workspace's `testing/`); see importProblems
//
// Reads the working tree (tracked and untracked, minus ignored), so uncommitted moves count.
// Usage: structure-check.mjs [root]. The default root is the repository holding this script.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE = /^(apps|packages)\/[^/]+\/src\/(.+)$/;
const BANNED_NAME = /^(utils?|helpers?|common|misc|manager|shared)$/;

function placementFault(sourcePath) {
  const dirs = sourcePath.split("/").slice(0, -1);
  if (!dirs.includes("integration")) return 'belongs in a feature\'s "integration" directory';
  if (dirs.length === 1)
    return 'catch-all "integration" directory at the workspace root: use <feature>/integration/ or integration/<area>/';
  return null;
}

function fileProblems(file, sourcePath) {
  const problems = [];
  if (file.split("/").some((s) => BANNED_NAME.test(s.replace(/\..*$/, "")))) {
    problems.push(`${file}: generic name (utils, helpers, common, misc, manager, shared)`);
  }
  if (!file.includes(".integration.test.")) return problems;
  if (!file.endsWith(".integration.test.ts")) {
    problems.push(`${file}: integration tests must be .ts; other extensions are never run`);
    return problems;
  }
  const fault = placementFault(sourcePath);
  if (fault) problems.push(`${file}: ${fault}`);
  return problems;
}

export function findProblems(files) {
  const scanned = files.filter((file) => SOURCE.test(file));
  const problems = scanned.flatMap((file) => fileProblems(file, SOURCE.exec(file)[2]));
  if (scanned.length === 0) problems.push("no source files scanned: wrong root or empty checkout");
  return problems;
}

// The integration area of a repository path: `<feature>/integration` (nested directories
// included), or `src/integration/<area>`. null outside `src` or outside every integration area.
function integrationArea(path) {
  const match = SOURCE.exec(path);
  if (!match) return null;
  const prefix = path.slice(0, path.length - match[2].length);
  const parts = match[2].split("/").slice(0, -1);
  const at = parts.indexOf("integration");
  if (at === -1) return null;
  return prefix + parts.slice(0, at === 0 ? 2 : at + 1).join("/");
}

const CODE = /\.(ts|tsx|mts|cts)$/;

// Relative specifiers (static, `export … from`, dynamic `import()`, `require`) found by the
// TypeScript scanner, so comments and strings that merely look like imports are ignored. The
// scanner misses `export * as ns from "…"`, so export declarations are also read from the AST.
function relativeImports(text) {
  const names = new Set(ts.preProcessFile(text, true, true).importedFiles.map((i) => i.fileName));
  const source = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest);
  for (const node of source.statements) {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      names.add(node.moduleSpecifier.text);
    }
  }
  return [...names].filter((name) => name.startsWith("."));
}

// An integration file may import its own area and anything outside integration areas, never
// another area's private files. Targets resolve by path, so `../x/../recovery/y` and `./../y` count.
export function importProblems(files, read) {
  const problems = [];
  for (const file of files) {
    const area = CODE.test(file) ? integrationArea(file) : null;
    if (area === null) continue;
    for (const name of relativeImports(read(file))) {
      const owner = integrationArea(posix.join(posix.dirname(file), name));
      if (owner !== null && owner !== area) {
        problems.push(
          `${file}: imports "${name}" from another integration area; move shared support to the workspace's testing/`,
        );
      }
    }
  }
  return problems;
}

export function listFiles(root) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file && existsSync(join(root, file))); // moved files stay in the index until staged
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root =
    process.argv[2] ??
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
    }).trim();
  const files = listFiles(root);
  const problems = [
    ...findProblems(files),
    ...importProblems(files, (file) => readFileSync(join(root, file), "utf8")),
  ];
  if (problems.length > 0) {
    console.error(`structure-check: ${problems.length} problem(s)\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log("structure-check: ok");
}
