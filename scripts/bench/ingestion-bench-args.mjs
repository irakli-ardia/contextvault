// Strict command line of the ingestion benchmark: unknown, repeated or malformed options are
// errors, so the recorded configuration is exactly what was asked for.

import { join, resolve } from "node:path";
import { insideRepository } from "./keyword-experiment-args.mjs";

const root = new URL("../../", import.meta.url).pathname;
const OPTIONS = { execute: false, smoke: false, repeats: true, rounds: true, out: true };
const COMMANDS = ["plan", "run", "cleanup"];
export const DEFAULT_REPEATS = 5;
export const DEFAULT_ROUNDS = 3;
export const MAX_REPEATS = 20;
export const MAX_ROUNDS = 9;

const usage = (why) =>
  new Error(
    `${why}\nusage: plan | run --execute [--smoke] [--repeats=1..20] [--rounds=3|6|9] [--out=<file.json>] | cleanup`,
  );

function integer(name, text, fallback) {
  if (text === undefined) return fallback;
  if (!/^\d+$/.test(text)) throw usage(`--${name} is not an integer`);
  return Number(text);
}

/** A flag takes no value; a value option needs exactly one, without '=' or NUL. */
function assertValue(name, value) {
  const bad = OPTIONS[name] ? !value || /[=\0]/.test(value) : value !== undefined;
  if (bad) throw usage(OPTIONS[name] ? `--${name} needs one value` : `--${name} takes no value`);
}

/** One `--name[=value]` argument as [name, value]; refuses what the option table does not allow. */
function option(arg, given) {
  const eq = arg.indexOf("=");
  const name = arg.slice(2, eq === -1 ? undefined : eq);
  const value = eq === -1 ? undefined : arg.slice(eq + 1);
  if (!Object.hasOwn(OPTIONS, name)) throw usage(`unknown option --${name}`);
  if (Object.hasOwn(given, name)) throw usage(`--${name} given twice`);
  assertValue(name, value);
  return [name, value ?? true];
}

function split(argv) {
  const given = {};
  const positional = [];
  for (const arg of argv) {
    if (!arg.startsWith("--")) positional.push(arg);
    else Object.assign(given, Object.fromEntries([option(arg, given)]));
  }
  return { given, positional };
}

/** The rules tying a command to the options it accepts. */
function assertCommand(command, positional, given) {
  const rules = [
    [positional.length > 1 || !COMMANDS.includes(command), "unknown command"],
    [command === "cleanup" && Object.keys(given).length > 0, "cleanup takes no options"],
    [given.execute === true && command !== "run", "--execute belongs to run"],
  ];
  const broken = rules.find(([bad]) => bad);
  if (broken) throw usage(broken[1]);
}

export function parseArgs(argv) {
  const { given, positional } = split(argv);
  const command = positional[0] ?? "plan";
  assertCommand(command, positional, given);
  const repeats = integer("repeats", given.repeats, DEFAULT_REPEATS);
  const rounds = integer("rounds", given.rounds, DEFAULT_ROUNDS);
  if (repeats < 1 || repeats > MAX_REPEATS) throw usage("--repeats is outside 1..20");
  // Whole rotations of the concurrency levels keep every level in every position equally often.
  if (rounds % 3 !== 0 || rounds < 3 || rounds > MAX_ROUNDS) {
    throw usage("--rounds is not 3, 6 or 9");
  }
  const { execute, smoke, out } = given;
  return { command, execute: execute === true, smoke: smoke === true, repeats, rounds, out };
}

/** The default tracked file is for a full run only; a smoke run must write outside the repository. */
export function resolveOutput({ out, smoke, cwd = process.cwd(), repo = root }) {
  if (out === undefined && smoke) throw new Error("--out=<file.json> is required for --smoke");
  const path =
    out === undefined
      ? join(repo, "benchmarks/ingestion/ingestion-baseline.json")
      : resolve(cwd, out);
  if (!path.endsWith(".json")) throw new Error("the output file must end in .json");
  if (smoke && insideRepository(repo, path))
    throw new Error("a --smoke run must write outside the repository");
  return path;
}
