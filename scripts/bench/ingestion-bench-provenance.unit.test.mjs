import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  containerFacts,
  explicitArgs,
  gitProvenance,
  leaks,
  newExperimentId,
  sanitizeText,
} from "./ingestion-bench-provenance.mjs";

const answers = (map) => (_git, args) => {
  const out = map[args[0]];
  return out === undefined ? { status: 1, stdout: "" } : { status: 0, stdout: out };
};
const roots = { repo: "/Users/me/Projects/cv/", home: "/Users/me" };

describe("gitProvenance", () => {
  it("records sha, dirtiness, relative dirty files and a content-free diff fingerprint", () => {
    const run = answers({
      "rev-parse": "abc123\n",
      status: " M apps/worker/a.ts\0?? apps/worker/new.ts\0?? .env.test\0",
      diff: "diff text",
    });
    expect(gitProvenance(run)).toEqual({
      gitSha: "abc123",
      workingTreeDirty: true,
      dirtyFiles: [
        { status: "M", path: "apps/worker/a.ts" },
        { status: "??", path: "apps/worker/new.ts" },
        { status: "??", path: "<redacted>" },
      ],
      dirtyFilesTruncated: false,
      diffSha256: createHash("sha256").update("diff text").digest("hex"),
    });
  });
  it("reports a clean tree with no files", () => {
    const result = gitProvenance(answers({ "rev-parse": "abc\n", status: "", diff: "" }));
    expect(result).toMatchObject({ workingTreeDirty: false, dirtyFiles: [] });
  });
  it("caps the list and says so", () => {
    const status = Array.from({ length: 150 }, (_, i) => `?? f${i}`).join("\0");
    const result = gitProvenance(answers({ "rev-parse": "abc\n", status, diff: "" }));
    expect(result.dirtyFiles).toHaveLength(100);
    expect(result.dirtyFilesTruncated).toBe(true);
  });
  it("is null, not a guess, when git fails", () => {
    expect(gitProvenance(() => ({ status: 1, stdout: "" }))).toMatchObject({
      gitSha: null,
      workingTreeDirty: null,
      dirtyFiles: null,
    });
    expect(
      gitProvenance(() => {
        throw new Error("no git");
      }).gitSha,
    ).toBeNull();
  });
});

describe("experiment id", () => {
  it("is unique per call", () => expect(newExperimentId()).not.toBe(newExperimentId()));
});

describe("explicitArgs", () => {
  it("keeps the arguments and reduces the output path to its file name", () => {
    expect(explicitArgs(["run", "--execute", "--out=/Users/me/private/r.json"])).toEqual([
      "run",
      "--execute",
      "--out=r.json",
    ]);
  });
});

describe("containerFacts", () => {
  it("states the image, its local id and the resource limits", () => {
    const facts = containerFacts(
      { Image: "sha256:abc", HostConfig: { Memory: 4 * 2 ** 30, NanoCpus: 2e9, PidsLimit: 512 } },
      "pg@sha256:def",
    );
    expect(facts).toEqual({
      image: "pg@sha256:def",
      imageId: "sha256:abc",
      memoryLimitBytes: 4 * 2 ** 30,
      cpuLimit: 2,
      pidsLimit: 512,
    });
  });
  it("uses null for a limit docker does not state", () => {
    expect(containerFacts({ HostConfig: {} }, "x")).toMatchObject({
      imageId: null,
      memoryLimitBytes: null,
      cpuLimit: null,
    });
  });
});

describe("sanitizeText and leaks", () => {
  const secret = "s3cr3t-value";
  it("removes secrets, connection strings and private paths from free text", () => {
    const text = `connect postgresql://u:${secret}@127.0.0.1:5/db failed in /Users/me/Projects/cv/apps/x.ts for ${secret}; HOME /Users/me/.cache`;
    const clean = sanitizeText(text, [secret], roots);
    expect(clean).not.toContain(secret);
    expect(clean).toContain("<url>");
    expect(clean).toContain("<repo>/apps/x.ts");
    expect(leaks(clean, [secret], roots)).toEqual([]);
  });
  it("names what a result would leak, without the value", () => {
    expect(leaks(`x ${secret}`, [secret], roots)).toEqual(["a generated secret"]);
    expect(leaks("redis://127.0.0.1:55002", [], roots)).toEqual(["a connection string"]);
    expect(leaks("postgresql://u:p@h/d", [], roots)).toContain("a connection string");
    expect(leaks("/Users/me/Projects/cv/a", [], roots)).toEqual(["an absolute path"]);
    expect(leaks("/Users/me/x", [], roots)).toEqual(["an absolute path"]);
  });
  it("passes an ordinary result", () => {
    expect(
      leaks(
        JSON.stringify({ gitSha: "abc", plan: ["sequential, concurrency 1"] }),
        [secret],
        roots,
      ),
    ).toEqual([]);
  });
});
