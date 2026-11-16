import { describe, expect, it } from "vitest";
import { parseArgs, resolveOutput } from "./ingestion-bench-args.mjs";

describe("parseArgs", () => {
  it("defaults to a plan with the documented configuration", () => {
    expect(parseArgs([])).toEqual({
      command: "plan",
      execute: false,
      smoke: false,
      repeats: 5,
      rounds: 3,
      out: undefined,
    });
  });
  it("reads every option", () => {
    expect(
      parseArgs(["run", "--execute", "--smoke", "--repeats=2", "--rounds=6", "--out=a.json"]),
    ).toEqual({
      command: "run",
      execute: true,
      smoke: true,
      repeats: 2,
      rounds: 6,
      out: "a.json",
    });
  });
  it.each([
    [["run", "--bogus"], /unknown option/],
    [["run", "--repeats=2", "--repeats=3"], /given twice/],
    [["run", "--execute=1"], /takes no value/],
    [["run", "--repeats"], /needs one value/],
    [["run", "--repeats=abc"], /not an integer/],
    [["run", "--repeats=0"], /outside 1..20/],
    [["run", "--repeats=21"], /outside 1..20/],
    [["run", "--rounds=4"], /3, 6 or 9/],
    [["run", "--rounds=12"], /3, 6 or 9/],
    [["--execute"], /belongs to run/],
    [["cleanup", "--smoke"], /no options/],
    [["run", "plan"], /unknown command/],
  ])("refuses %j", (argv, message) => expect(() => parseArgs(argv)).toThrow(message));
});

describe("resolveOutput", () => {
  const repo = "/work/repo/";
  it("uses the tracked default only for a full run", () => {
    expect(resolveOutput({ smoke: false, repo })).toBe(
      "/work/repo/benchmarks/ingestion/ingestion-baseline.json",
    );
  });
  it("requires a file outside the repository for a smoke run", () => {
    expect(() => resolveOutput({ smoke: true, repo })).toThrow(/--out/);
    expect(() => resolveOutput({ smoke: true, out: "/work/repo/x.json", repo })).toThrow(
      /outside the repository/,
    );
    expect(resolveOutput({ smoke: true, out: "/elsewhere/x.json", repo })).toBe(
      "/elsewhere/x.json",
    );
  });
  it("requires a .json file", () => {
    expect(() => resolveOutput({ smoke: false, out: "/elsewhere/x.txt", repo })).toThrow(/\.json/);
  });
});
