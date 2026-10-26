import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError, loadEnv, parseApiEnv, parseEnv, parseWorkerEnv } from "./env";

const SECRET = "s3cr3t-value-must-not-leak";

function messageOf(source: Record<string, string | undefined>): string {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error.message;
  }
  throw new Error("expected EnvError");
}

describe("parseEnv", () => {
  it.each(["development", "test", "production"] as const)("accepts NODE_ENV=%s", (nodeEnv) => {
    expect(parseEnv({ NODE_ENV: nodeEnv })).toEqual({ NODE_ENV: nodeEnv });
  });

  it("ignores unrelated variables", () => {
    expect(parseEnv({ NODE_ENV: "test", API_TOKEN: SECRET, PATH: "/bin" })).toEqual({
      NODE_ENV: "test",
    });
  });

  it.each([
    ["missing", {}],
    ["undefined", { NODE_ENV: undefined }],
    ["empty", { NODE_ENV: "" }],
    ["unknown value", { NODE_ENV: SECRET }],
    ["wrong case", { NODE_ENV: "Production" }],
    ["padded", { NODE_ENV: " test " }],
  ])("rejects %s NODE_ENV, naming the variable and never the value", (_case, source) => {
    const message = messageOf(source);
    expect(message).toContain("NODE_ENV");
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("Production");
  });
});

describe("loadEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads the ambient environment", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(loadEnv()).toEqual({ NODE_ENV: "production" });
  });

  it("throws EnvError for an invalid ambient environment", () => {
    vi.stubEnv("NODE_ENV", SECRET);
    expect(() => loadEnv()).toThrow(EnvError);
    expect(() => loadEnv()).not.toThrow(SECRET);
  });
});

describe("parseApiEnv", () => {
  it("coerces API_PORT to a number", () => {
    expect(parseApiEnv({ NODE_ENV: "test", API_PORT: "3001" })).toEqual({
      NODE_ENV: "test",
      API_PORT: 3001,
    });
  });

  it.each(["", "abc", "0", "65536", "1.5", SECRET])(
    "rejects API_PORT=%j without echoing it",
    (port) => {
      expect(() => parseApiEnv({ NODE_ENV: "test", API_PORT: port })).toThrow(/API_PORT/);
      expect(() => parseApiEnv({ NODE_ENV: "test", API_PORT: port })).not.toThrow(SECRET);
    },
  );

  it("rejects a missing API_PORT", () => {
    expect(() => parseApiEnv({ NODE_ENV: "test" })).toThrow(/API_PORT/);
  });
});

describe("parseWorkerEnv", () => {
  it("accepts redis and rediss URLs", () => {
    for (const REDIS_URL of ["redis://localhost:6379", "rediss://:pw@host:6380/1"]) {
      expect(parseWorkerEnv({ NODE_ENV: "test", REDIS_URL }).REDIS_URL).toBe(REDIS_URL);
    }
  });

  it.each(["", "not a url", "http://localhost:6379", `redis-${SECRET}`])(
    "rejects REDIS_URL=%j without echoing it",
    (url) => {
      expect(() => parseWorkerEnv({ NODE_ENV: "test", REDIS_URL: url })).toThrow(/REDIS_URL/);
      expect(() => parseWorkerEnv({ NODE_ENV: "test", REDIS_URL: url })).not.toThrow(SECRET);
    },
  );
});
