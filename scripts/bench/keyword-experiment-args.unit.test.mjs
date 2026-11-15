import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCreatable,
  parseArgs,
  provenance,
  resolveOutput,
  writeOnce,
} from "./keyword-experiment-args.mjs";

describe("parseArgs", () => {
  it("defaults to a full-size plan", () => {
    expect(parseArgs([])).toEqual({
      command: "plan",
      execute: false,
      chunks: 50_000,
      out: undefined,
    });
  });
  it("accepts the maximum of 100000 chunks", () => {
    expect(parseArgs(["run", "--chunks=100000", "--out=/tmp/r.json"]).chunks).toBe(100_000);
  });
  it("reads a run", () => {
    expect(parseArgs(["run", "--execute", "--chunks=1000", "--out=/tmp/r.json"])).toEqual({
      command: "run",
      execute: true,
      chunks: 1000,
      out: "/tmp/r.json",
    });
  });
  it.each([
    [["--nope"], /unknown option/],
    [["run", "--execute", "--execute"], /twice/],
    [["run", "--chunks=1000", "--chunks=2000"], /twice/],
    [["run", "--execute=yes"], /takes no value/],
    [["run", "--chunks"], /needs one value/],
    [["run", "--chunks="], /needs one value/],
    [["run", "--out=a=b.json"], /without '='/],
    [["run", "--chunks=1e4"], /not an integer/],
    [["run", "--chunks=-5"], /not an integer/],
    [["run", "--chunks=999"], /outside/],
    [["run", "--chunks=100001"], /outside/],
    [["run", "--chunks=1000=2"], /without '='/],
    [["plan", "--execute"], /belongs to run/],
    [["cleanup", "--chunks=1000"], /no options/],
    [["run", "plan"], /unknown command/],
    [["destroy"], /unknown command/],
    [["--toString"], /unknown option/],
    [["--__proto__=x"], /unknown option/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe("resolveOutput", () => {
  const repo = "/work/repo";
  it("uses the tracked benchmark file only for a full-size run", () => {
    expect(resolveOutput({ chunks: 50_000, repo })).toBe(
      "/work/repo/benchmarks/retrieval/keyword-experiment.json",
    );
  });
  it("keeps a 100000-chunk run outside the repository", () => {
    expect(() => resolveOutput({ chunks: 100_000, repo })).toThrow(/--out/);
    expect(() => resolveOutput({ chunks: 100_000, out: "/work/repo/x.json", repo })).toThrow(
      /outside the repository/,
    );
    expect(resolveOutput({ chunks: 100_000, out: "/tmp/x.json", repo })).toBe("/tmp/x.json");
  });
  it("requires an explicit file for a smoke run", () => {
    expect(() => resolveOutput({ chunks: 1000, repo })).toThrow(/--out/);
  });
  it("keeps a smoke run out of the repository, including through ..", () => {
    expect(() => resolveOutput({ chunks: 1000, out: "/work/repo/x.json", repo })).toThrow(
      /outside the repository/,
    );
    expect(() =>
      resolveOutput({ chunks: 1000, out: "../repo/x.json", cwd: "/work/other", repo }),
    ).toThrow(/outside/);
    expect(resolveOutput({ chunks: 1000, out: "/tmp/x.json", repo })).toBe("/tmp/x.json");
    expect(resolveOutput({ chunks: 1000, out: "/work/repo-sibling/x.json", repo })).toBe(
      "/work/repo-sibling/x.json",
    );
  });
  it("accepts only json files", () => {
    expect(() => resolveOutput({ chunks: 1000, out: "/tmp/x.txt", repo })).toThrow(/\.json/);
  });
});

describe("output path through symlinks", () => {
  let base;
  let repo;
  let outside;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "kwexp-link-")));
    repo = join(base, "repo");
    outside = join(base, "outside");
    mkdirSync(join(repo, "benchmarks"), { recursive: true });
    mkdirSync(outside);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("rejects a directory outside the repository that links into it", () => {
    symlinkSync(join(repo, "benchmarks"), join(outside, "alias"));
    expect(() =>
      resolveOutput({ out: join(outside, "alias", "r.json"), chunks: 1000, repo }),
    ).toThrow(/outside the repository/);
  });
  it("rejects a repository reached through a link to it", () => {
    symlinkSync(repo, join(outside, "repo-link"));
    expect(() =>
      resolveOutput({ out: "r.json", chunks: 1000, cwd: join(outside, "repo-link"), repo }),
    ).toThrow(/outside the repository/);
    expect(() =>
      resolveOutput({
        out: join(repo, "benchmarks", "r.json"),
        chunks: 1000,
        repo: join(outside, "repo-link"),
      }),
    ).toThrow(/outside the repository/);
  });
  // Only meaningful where the filesystem ignores case (the default on macOS); elsewhere the
  // swapped spelling does not exist and there is nothing to bypass.
  const swapCase = (text) =>
    text.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  it("rejects a repository path spelled with different letter casing", (context) => {
    const swapped = swapCase(repo);
    if (!existsSync(swapped) || realpathSync.native(swapped) !== repo) context.skip();
    const out = join(swapped, "benchmarks", "r.json");
    expect(() => resolveOutput({ out, chunks: 1000, repo })).toThrow(/outside the repository/);
    expect(() =>
      resolveOutput({ out: join(repo, "benchmarks", "r.json"), chunks: 1000, repo: swapped }),
    ).toThrow(/outside the repository/);
  });
  it("accepts a link that stays outside the repository", () => {
    mkdirSync(join(outside, "real"));
    symlinkSync(join(outside, "real"), join(outside, "alias"));
    const out = join(outside, "alias", "r.json");
    expect(resolveOutput({ out, chunks: 1000, repo })).toBe(out);
  });
});

describe("output files", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kwexp-out-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a file once, privately, leaving no temporary file", () => {
    const path = join(dir, "r.json");
    assertCreatable(path);
    writeOnce(path, "{}\n");
    expect(readFileSync(path, "utf8")).toBe("{}\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["r.json"]);
  });
  it("never replaces an existing file, and keeps the finished result in its temporary file", () => {
    const path = join(dir, "r.json");
    writeFileSync(path, "keep");
    expect(() => assertCreatable(path)).toThrow(/already exists/);
    expect(() => writeOnce(path, "new")).toThrow(/kept at .*\.tmp: EEXIST/);
    expect(readFileSync(path, "utf8")).toBe("keep");
    const [temp] = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(readFileSync(join(dir, temp), "utf8")).toBe("new");
  });
  it("keeps the temporary file and reports its path when the link fails", () => {
    const path = join(dir, "r.json");
    const link = () => {
      throw Object.assign(new Error("not supported"), { code: "EPERM" });
    };
    let message;
    try {
      writeOnce(path, "results", { link });
    } catch (error) {
      message = error.message;
    }
    const [temp] = readdirSync(dir);
    expect(message).toBe(`result not published, kept at ${join(dir, temp)}: EPERM`);
    expect(temp).toMatch(/^r\.json\.\d+\.tmp$/);
    expect(readFileSync(join(dir, temp), "utf8")).toBe("results");
    expect(existsSync(path)).toBe(false);
  });
  it("loses a race for the destination without overwriting the winner or the results", () => {
    const path = join(dir, "r.json");
    const racing = (from, to) => {
      writeFileSync(to, "winner"); // created after assertCreatable passed
      linkSync(from, to);
    };
    assertCreatable(path);
    expect(() => writeOnce(path, "mine", { link: racing })).toThrow(/EEXIST/);
    expect(readFileSync(path, "utf8")).toBe("winner");
    const [temp] = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(readFileSync(join(dir, temp), "utf8")).toBe("mine");
  });
  it("refuses a dangling symlink and a missing directory", () => {
    const link = join(dir, "link.json");
    symlinkSync(join(dir, "nowhere"), link);
    expect(() => assertCreatable(link)).toThrow(/already exists/);
    expect(existsSync(join(dir, "nowhere"))).toBe(false);
    expect(() => assertCreatable(join(dir, "missing", "r.json"))).toThrow(/directory/);
  });
});

describe("provenance", () => {
  it("records the commit and whether the tree is dirty", () => {
    const run = (_cmd, args) =>
      args[0] === "rev-parse"
        ? { status: 0, stdout: "abc123\n" }
        : { status: 0, stdout: " M file\n" };
    expect(provenance(run)).toEqual({ gitSha: "abc123", workingTreeDirty: true });
    expect(
      provenance((_c, a) =>
        a[0] === "rev-parse" ? { status: 0, stdout: "abc\n" } : { status: 0, stdout: "" },
      ),
    ).toEqual({ gitSha: "abc", workingTreeDirty: false });
  });
  it("does not require git to succeed", () => {
    expect(provenance(() => ({ status: 128, stdout: "" }))).toEqual({
      gitSha: null,
      workingTreeDirty: null,
    });
    expect(
      provenance(() => {
        throw new Error("ENOENT");
      }),
    ).toEqual({ gitSha: null, workingTreeDirty: null });
  });
});
