#!/usr/bin/env node
// Keeps the documentation system honest:
//   - no unresolved scaffold placeholders or FILL markers
//   - every relative Markdown link points at a real file, and every #anchor at a real heading
//   - entry points stay inside their line budgets (warnings; errors with --strict)
//
//   docs-check.mjs [--root <dir>] [--strict]
//
// Runs under both Node and Bun; no dependencies.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  ".expo",
  "dist",
  "build",
  "coverage",
  "temp",
  "worktrees",
  ".claude",
  ".agents",
]);
const TOKEN_BUDGETS = {}; // estimated characters / 4, keyed by repo-relative path
const LINE_BUDGETS = {
};

// Leftover scaffold syntax: variables, if/unless/each block tags, and else.
const PLACEHOLDER = /\{\{(?:[A-Z][A-Z0-9_]*|[#/](?:if|unless|each)\b[^}]*|else)\}\}/;
const FILL_MARKER = "<!-" + "- FILL";
const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HTML_ANCHOR = /<a\s+(?:id|name)="([^"]+)"/g;
const INLINE_CODE = /`[^`]*`/g;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function isFence(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root") {
      args.root = argv[++index];
    } else if (argv[index] === "--strict") {
      args.strict = true;
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  return { ...args, root: resolve(args.root) };
}

function shouldSkip(name) {
  return SKIP_DIRS.has(name);
}

function filesNamed(root, matches) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkip(entry.name)) {
          walk(full);
        }
      } else if (entry.isFile() && matches(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

function slugify(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll("`", "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replaceAll(" ", "-");
}

const anchorCache = new Map();

function anchorsOf(file) {
  const cached = anchorCache.get(file);
  if (cached) {
    return cached;
  }
  const anchors = new Set();
  const counts = new Map();
  let fenced = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (isFence(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const base = slugify(heading[2] ?? "");
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      anchors.add(seen === 0 ? base : `${base}-${seen}`);
    }
    for (const match of line.matchAll(HTML_ANCHOR)) {
      anchors.add(match[1]);
    }
  }
  anchorCache.set(file, anchors);
  return anchors;
}

function checkLink(root, file, target) {
  if (EXTERNAL.test(target)) {
    return null;
  }
  const hashIndex = target.indexOf("#");
  const pathPart = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const anchor = hashIndex >= 0 ? safeDecode(target.slice(hashIndex + 1)) : "";
  const decoded = safeDecode(pathPart);
  if (anchor === null || decoded === null) {
    return `malformed link: ${target}`;
  }
  let destination = file;
  if (decoded.length > 0) {
    destination = decoded.startsWith("/") ? join(root, decoded) : resolve(dirname(file), decoded);
  }
  if (!existsSync(destination)) {
    return `broken link: ${target}`;
  }
  if (anchor && destination.endsWith(".md") && statSync(destination).isFile()) {
    if (!anchorsOf(destination).has(anchor.toLowerCase())) {
      return `missing anchor: ${target}`;
    }
  }
  return null;
}

function checkFile(root, file, errors) {
  const rel = relative(root, file).split(sep).join("/");
  const lines = readFileSync(file, "utf8").split("\n");
  let fenced = false;
  lines.forEach((line, index) => {
    const where = `${rel}:${index + 1}`;
    if (line.includes(FILL_MARKER)) {
      errors.push(`${where} — unfilled FILL marker`);
    }
    const placeholder = PLACEHOLDER.exec(line);
    if (placeholder) {
      errors.push(`${where} — unresolved placeholder ${placeholder[0]}`);
    }
    if (isFence(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) {
      return;
    }
    for (const match of line.replace(INLINE_CODE, "").matchAll(LINK)) {
      const problem = checkLink(root, file, match[1] ?? "");
      if (problem) {
        errors.push(`${where} — ${problem}`);
      }
    }
  });
  const tokenBudget = TOKEN_BUDGETS[rel];
  const estimatedTokens = Math.ceil(lines.join("\n").length / 4);
  if (tokenBudget && estimatedTokens > tokenBudget) {
    return `${rel} has ~${estimatedTokens} tokens (budget ${tokenBudget}); move topic detail into linked docs`;
  }
  const budget = LINE_BUDGETS[rel];
  return budget !== undefined && lines.length > budget
    ? `${rel} has ${lines.length} lines (budget ${budget}); move closed items out or into a linked plan`
    : null;
}

function main() {
  const { root, strict } = parseArgs(process.argv.slice(2));
  const errors = [];
  const warnings = [];
  const files = filesNamed(root, (name) => name.endsWith(".md"));
  for (const file of files) {
    const warning = checkFile(root, file, errors);
    if (warning) {
      (strict ? errors : warnings).push(warning);
    }
  }
  if (files.length === 0) {
    errors.push(
      `no Markdown files found under ${root} — wrong --root, or the scan is skipping everything`,
    );
  }
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    console.error(`\ndocs-check: ${errors.length} problem(s) in ${files.length} Markdown files`);
    process.exit(1);
  }
  console.log(`docs-check: ${files.length} Markdown files OK`);
}

try {
  main();
} catch (error) {
  console.error(`[docs-check] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
