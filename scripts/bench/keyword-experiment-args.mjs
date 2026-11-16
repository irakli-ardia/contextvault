// Command line, output location and provenance of the experiment. Strict on purpose: unknown
// options, repeated options and ambiguous values are errors, and a result file is created once,
// atomically, and never replaces another file.

import { spawnSync } from "node:child_process";
import { linkSync, lstatSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
export const FULL_CHUNKS = 50_000;
export const MAX_CHUNKS = 100_000;
export const MIN_CHUNKS = 1000;
const COMMANDS = ["plan", "run", "cleanup"];
const OPTIONS = { execute: false, chunks: true, out: true }; // true: takes a value

const usage = (why) =>
  new Error(
    `${why}\nusage: plan | run --execute [--chunks=1000..100000] [--out=<file.json>] | cleanup`,
  );

const BAD_VALUE = /[=\0]/;

/** A value-taking option needs exactly one non-empty value; a flag takes none. */
function assertShape(name, value) {
  if (!OPTIONS[name]) {
    if (value !== undefined) throw usage(`--${name} takes no value`);
    return;
  }
  if (!value || BAD_VALUE.test(value)) {
    throw usage(`--${name} needs one value without '=' (--${name}=<value>)`);
  }
}

/** One `--name[=value]` argument as [name, value], validated against OPTIONS and `given`. */
function parseOption(arg, given) {
  const eq = arg.indexOf("=");
  const name = arg.slice(2, eq === -1 ? undefined : eq);
  if (!Object.hasOwn(OPTIONS, name)) throw usage(`unknown option --${name}`);
  if (Object.hasOwn(given, name)) throw usage(`--${name} given twice`);
  const value = eq === -1 ? undefined : arg.slice(eq + 1);
  assertShape(name, value);
  return [name, value ?? true];
}

function parseChunks(text) {
  if (text === undefined) return FULL_CHUNKS;
  if (!/^\d+$/.test(text)) throw usage("--chunks is not an integer");
  const chunks = Number(text);
  if (chunks < MIN_CHUNKS || chunks > MAX_CHUNKS) throw usage("--chunks is outside 1000..100000");
  return chunks;
}

export function parseArgs(argv) {
  const given = {};
  const positional = argv.filter((arg) => {
    if (!arg.startsWith("--")) return true;
    const [name, value] = parseOption(arg, given);
    given[name] = value;
    return false;
  });
  const command = positional[0] ?? "plan";
  if (positional.length > 1 || !COMMANDS.includes(command)) throw usage("unknown command");
  if (command === "cleanup" && Object.keys(given).length > 0) {
    throw usage("cleanup takes no options");
  }
  if (given.execute && command !== "run") throw usage("--execute belongs to run");
  return {
    command,
    execute: given.execute === true,
    chunks: parseChunks(given.chunks),
    out: given.out,
  };
}

const inside = (parent, path) => {
  const rel = relative(parent, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

// `.native` asks the OS for the on-disk spelling, so a differently cased path on a
// case-insensitive filesystem (macOS) still compares equal to the repository.
const real = (path) => {
  try {
    return realpathSync.native(path);
  } catch {
    return path; // a missing directory is refused later by assertCreatable
  }
};

/** True when the path is in the repository by its spelling or after following every symlink. */
export const insideRepository = (repo, path) =>
  inside(repo, path) || inside(real(repo), join(real(dirname(path)), basename(path)));

/**
 * Only a run of exactly the default size may use the default file in the tracked benchmark directory; any other size
 * must name a file outside the repository, so a smoke test can never become a published result.
 */
export function resolveOutput({ out, chunks, cwd = process.cwd(), repo = root }) {
  const full = chunks === FULL_CHUNKS;
  if (out === undefined && !full) {
    throw new Error("--out=<file.json> is required for a run of any size other than 50000 chunks");
  }
  const path =
    out === undefined
      ? join(repo, "benchmarks/retrieval/keyword-experiment.json")
      : resolve(cwd, out);
  if (!path.endsWith(".json")) throw new Error("the output file must end in .json");
  if (out !== undefined && !full && insideRepository(repo, path)) {
    throw new Error("a run of any size other than 50000 chunks must write outside the repository");
  }
  return path;
}

/** Refuses before any container exists: a missing directory, or any existing file or link. */
export function assertCreatable(path, { lstat = lstatSync, stat = statSync } = {}) {
  if (!stat(dirname(path), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("the output directory does not exist");
  }
  if (lstat(path, { throwIfNoEntry: false }) !== undefined) {
    throw new Error("the output file already exists: nothing is overwritten");
  }
}

/**
 * Temp file in the same directory, then a hard link: it fails with EEXIST instead of replacing.
 * The temp file is the only copy of a finished run, so a failed link keeps it and names it.
 */
export function writeOnce(path, text, { link = linkSync } = {}) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
  try {
    link(temp, path);
  } catch (error) {
    throw new Error(`result not published, kept at ${temp}: ${error?.code ?? error?.message}`, {
      cause: error,
    });
  }
  unlinkSync(temp);
}

/** Commit and cleanliness of the checkout; null when git is missing or fails. */
export function provenance(run = spawnSync) {
  const git = (args) => {
    try {
      const done = run("git", args, { encoding: "utf8", cwd: root, timeout: 5000 });
      return done.status === 0 ? done.stdout.trim() : null;
    } catch {
      return null;
    }
  };
  const gitSha = git(["rev-parse", "HEAD"]);
  const status = gitSha === null ? null : git(["status", "--porcelain"]);
  return { gitSha, workingTreeDirty: status === null ? null : status.length > 0 };
}
