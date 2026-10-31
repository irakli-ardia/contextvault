import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, mark, verify } from "./with-ci-stack.mjs";

const MARKER = `cv-ci-${"a".repeat(32)}`;
const BASE = {
  DATABASE_URL: "postgres://app:p@127.0.0.1:5432/contextvault",
  DATABASE_MIGRATION_URL: "postgres://owner:p@127.0.0.1:5432/contextvault",
  DATABASE_FIXTURE_URL: "postgres://fixture:p@127.0.0.1:5432/contextvault",
  S3_ENDPOINT: "http://127.0.0.1:8333",
  S3_REGION: "us-east-1",
  S3_BUCKET: "contextvault-dev",
  S3_ACCESS_KEY_ID: "id",
  S3_SECRET_ACCESS_KEY: "secret",
  GITHUB_ACTIONS: "true",
  CI: "true",
};
const env = (extra = {}) => ({ ...BASE, CV_CI_DB_MARKER: MARKER, ...extra });
const io = (comment = MARKER, object = MARKER) => ({
  comment: vi.fn(async () => comment),
  object: vi.fn(async () => object),
  prepare: vi.fn(async () => {}),
});

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  vi.restoreAllMocks();
});
const githubEnv = () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-stack-"));
  dirs.push(dir);
  const file = join(dir, "github-env");
  writeFileSync(file, "");
  return file;
};

describe("verify", () => {
  it("accepts a database and a bucket that both carry this run's marker", async () => {
    await expect(verify(env(), io())).resolves.toBeUndefined();
  });

  it.each([
    ["no comment", io(null), "postgres identity marker is missing"],
    ["an empty comment", io(""), "postgres identity marker is missing"],
    ["the local cv-test marker", io("cv-test-marker"), "postgres identity marker does not match"],
    [
      "another run's marker",
      io(`cv-ci-${"b".repeat(32)}`),
      "postgres identity marker does not match",
    ],
    ["no bucket object", io(MARKER, ""), "s3 identity marker does not match"],
    ["another bucket marker", io(MARKER, "x"), "s3 identity marker does not match"],
  ])("refuses %s", async (_name, probes, message) => {
    await expect(verify(env(), probes)).rejects.toThrow(message);
  });

  it("refuses when the database or bucket cannot be read", async () => {
    const down = { ...io(), comment: async () => Promise.reject(new Error("down")) };
    await expect(verify(env(), down)).rejects.toThrow("postgres check failed");
    const noObject = { ...io(), object: async () => Promise.reject(new Error("404")) };
    await expect(verify(env(), noObject)).rejects.toThrow("s3 identity marker is missing");
  });

  it("does not trust the forgeable CI flags, or a marker that is missing or malformed", async () => {
    const { CV_CI_DB_MARKER: _gone, ...bare } = env();
    await expect(verify(bare, io())).rejects.toThrow("CV_CI_DB_MARKER is missing");
    await expect(verify(env({ CV_CI_DB_MARKER: "cv-test-marker" }), io())).rejects.toThrow(
      "invalid",
    );
    await expect(verify(env({ CV_TEST_DB_MARKER: MARKER }), io())).rejects.toThrow("invalid");
  });

  it("refuses non-loopback endpoints and mixed databases before reading anything", async () => {
    const probes = io();
    await expect(
      verify(env({ S3_ENDPOINT: "http://s3.example.com:8333" }), probes),
    ).rejects.toThrow("S3_ENDPOINT is not a loopback endpoint");
    await expect(
      verify(env({ DATABASE_FIXTURE_URL: "postgres://f:p@127.0.0.1:5432/other" }), probes),
    ).rejects.toThrow("must name one database");
    expect(probes.comment).not.toHaveBeenCalled();
  });
});

describe("mark", () => {
  it("writes a fresh random marker to GITHUB_ENV after preparing the stack", async () => {
    const GITHUB_ENV = githubEnv();
    const probes = io();
    const marker = await mark(env({ GITHUB_ENV }), probes);
    expect(marker).toMatch(/^cv-ci-[0-9a-f]{32}$/);
    expect(probes.prepare).toHaveBeenCalledWith(expect.anything(), marker);
    expect(readFileSync(GITHUB_ENV, "utf8")).toBe(`CV_CI_DB_MARKER=${marker}\n`);
  });

  it("writes nothing when the database or bucket is not fresh, or off a runner", async () => {
    const GITHUB_ENV = githubEnv();
    const stale = io();
    stale.prepare.mockRejectedValue(
      Object.assign(new Error("database is not freshly provisioned"), { name: "CiStackError" }),
    );
    await expect(mark(env({ GITHUB_ENV }), stale)).rejects.toThrow();
    expect(readFileSync(GITHUB_ENV, "utf8")).toBe("");
    await expect(mark(env(), io())).rejects.toThrow("GITHUB_ENV is not a runner file");
    await expect(mark(env({ GITHUB_ENV: "/nonexistent/file" }), io())).rejects.toThrow(
      "GITHUB_ENV is not a runner file",
    );
  });
});

describe("main", () => {
  it("starts the command once, with the verified flag, only after verification", async () => {
    const run = vi.fn(async () => 0);
    expect(await main(["run", "node", "x.js"], env(), { io: io(), run })).toBe(0);
    expect(run).toHaveBeenCalledWith(
      "node",
      ["x.js"],
      expect.objectContaining({ CV_TEST_STACK_VERIFIED: "1" }),
    );
  });

  it("never starts the command on a missing or mismatched marker", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(async () => 0);
    expect(await main(["run", "node"], env(), { io: io("dev comment"), run })).toBe(1);
    expect(await main(["run", "node"], env(), { io: io(null), run })).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects unknown usage", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["run"], env(), { io: io() })).toBe(2);
    expect(await main(["run", "--flag"], env(), { io: io() })).toBe(2);
  });
});
