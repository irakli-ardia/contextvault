import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBuiltFor, curlQuote, verifiedApi } from "../../apps/web/e2e/stack-env.ts";

const OK = {
  CV_TEST_STACK_VERIFIED: "1",
  API_PORT: "3201",
  API_INTERNAL_URL: "http://127.0.0.1:3201",
};
const use = (env) => {
  for (const [key, value] of Object.entries({ ...OK, ...env })) vi.stubEnv(key, value);
};
afterEach(() => vi.unstubAllEnvs());

describe("verifiedApi", () => {
  it("returns the agreed endpoint", () => {
    use({});
    expect(verifiedApi()).toEqual({ port: "3201", origin: "http://127.0.0.1:3201" });
  });

  it.each([
    [{ CV_TEST_STACK_VERIFIED: "" }, "not set by a verified stack"],
    [{ CV_TEST_STACK_VERIFIED: "true" }, "not set by a verified stack"],
    [{ API_PORT: "" }, "API_PORT is not set"],
    [{ API_PORT: "abc" }, "API_PORT is invalid"],
    [{ API_PORT: "65536" }, "API_PORT is invalid"],
    [{ API_PORT: "3001", API_INTERNAL_URL: "http://127.0.0.1:3001" }, "development API port"],
    [{ API_INTERNAL_URL: "not a url" }, "malformed"],
    [{ API_INTERNAL_URL: "http://127.0.0.1:3201/" }, "bare loopback"],
    [{ API_INTERNAL_URL: "http://10.0.0.5:3201" }, "bare loopback"],
    [{ API_INTERNAL_URL: "https://127.0.0.1:3201" }, "bare loopback"],
    [{ API_INTERNAL_URL: "http://127.0.0.1:3202" }, "disagree"],
  ])("rejects %j", (env, reason) => {
    use(env);
    expect(() => verifiedApi()).toThrow(reason);
  });
});

describe("assertBuiltFor", () => {
  const dirs = [];
  const manifest = (destinations) => {
    const dir = mkdtempSync(join(tmpdir(), "manifest-"));
    dirs.push(dir);
    const file = join(dir, "routes-manifest.json");
    writeFileSync(
      file,
      JSON.stringify({
        rewrites: { fallback: destinations.map((destination) => ({ destination })) },
      }),
    );
    return file;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a build frozen to the origin", () => {
    expect(() =>
      assertBuiltFor("http://127.0.0.1:3201", manifest(["http://127.0.0.1:3201/:path*"])),
    ).not.toThrow();
  });

  it("rejects a build frozen to the development API", () => {
    expect(() =>
      assertBuiltFor("http://127.0.0.1:3201", manifest(["http://127.0.0.1:3001/:path*"])),
    ).toThrow("different API origin");
  });

  it("rejects a prefix look-alike, no rewrite and a missing build", () => {
    expect(() =>
      assertBuiltFor("http://127.0.0.1:320", manifest(["http://127.0.0.1:3201/:path*"])),
    ).toThrow("different API origin");
    expect(() => assertBuiltFor("http://127.0.0.1:3201", manifest([]))).toThrow(
      "different API origin",
    );
    expect(() => assertBuiltFor("http://127.0.0.1:3201", join(tmpdir(), "absent.json"))).toThrow(
      "web build not found",
    );
  });
});

describe("curlQuote", () => {
  it("escapes what a double-quoted curl config string treats specially", () => {
    expect(curlQuote('a"b\\c\nd\te')).toBe('a\\"b\\\\c\\nd\\te');
    expect(curlQuote("plain/+=")).toBe("plain/+=");
  });
});
