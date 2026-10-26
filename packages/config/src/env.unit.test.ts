import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EnvError,
  loadDatabaseEnv,
  loadEnv,
  loadS3Env,
  parseApiEnv,
  parseDatabaseEnv,
  parseEnv,
  parseS3Env,
  parseWorkerEnv,
} from "./env";

const SECRET = "s3cr3t-value-must-not-leak";

const DATABASE = { DATABASE_URL: `postgres://app:${SECRET}@127.0.0.1:5432/db` };
const S3 = {
  S3_ENDPOINT: "http://127.0.0.1:8333",
  S3_BUCKET: "bucket",
  S3_ACCESS_KEY_ID: "access-key",
  S3_SECRET_ACCESS_KEY: SECRET,
};
const API = { NODE_ENV: "test", API_PORT: "3001" };
const WORKER = { NODE_ENV: "test", REDIS_URL: "redis://localhost:6379" };

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
    expect(parseApiEnv(API)).toMatchObject({ NODE_ENV: "test", API_PORT: 3001 });
  });

  it.each(["", "abc", "0", "65536", "1.5", SECRET])(
    "rejects API_PORT=%j without echoing it",
    (port) => {
      expect(() => parseApiEnv({ ...API, API_PORT: port })).toThrow(/API_PORT/);
      expect(() => parseApiEnv({ ...API, API_PORT: port })).not.toThrow(SECRET);
    },
  );

  it("rejects a missing API_PORT", () => {
    const { API_PORT: _omitted, ...source } = API;
    expect(() => parseApiEnv(source)).toThrow(/API_PORT/);
  });
});

describe("parseWorkerEnv", () => {
  it("accepts redis and rediss URLs", () => {
    for (const REDIS_URL of ["redis://localhost:6379", "rediss://:pw@host:6380/1"]) {
      expect(parseWorkerEnv({ ...WORKER, REDIS_URL }).REDIS_URL).toBe(REDIS_URL);
    }
  });

  it.each(["", "not a url", "http://localhost:6379", `redis-${SECRET}`])(
    "rejects REDIS_URL=%j without echoing it",
    (url) => {
      expect(() => parseWorkerEnv({ ...WORKER, REDIS_URL: url })).toThrow(/REDIS_URL/);
      expect(() => parseWorkerEnv({ ...WORKER, REDIS_URL: url })).not.toThrow(SECRET);
    },
  );
});

describe("app schemas stay independent of Postgres and S3", () => {
  it("api and worker parse without DATABASE_URL or S3_*", () => {
    expect(parseApiEnv(API)).toEqual({ NODE_ENV: "test", API_PORT: 3001 });
    expect(parseWorkerEnv(WORKER)).toEqual(WORKER);
  });

  it("api and worker ignore malformed DATABASE_URL and S3_* values", () => {
    const bad = { DATABASE_URL: "nonsense", S3_ENDPOINT: "nonsense", S3_BUCKET: "" };
    expect(() => parseApiEnv({ ...API, ...bad })).not.toThrow();
    expect(() => parseWorkerEnv({ ...WORKER, ...bad })).not.toThrow();
  });
});

describe.each([
  ["parseDatabaseEnv", parseDatabaseEnv, { NODE_ENV: "test", ...DATABASE }, Object.keys(DATABASE)],
  ["parseS3Env", parseS3Env, { NODE_ENV: "test", ...S3 }, Object.keys(S3)],
] as const)("%s", (_name, parse, valid, required) => {
  it("accepts the full set", () => {
    expect(parse(valid)).toMatchObject(valid);
  });

  it.each(required)("rejects missing and empty %s, naming it and never a secret", (name) => {
    for (const value of [undefined, ""]) {
      const run = () => parse({ ...valid, [name]: value });
      expect(run).toThrow(new RegExp(`- ${name}:`));
      expect(run).not.toThrow(SECRET);
    }
  });

  it("reports every missing variable at once", () => {
    expect(() => parse({ NODE_ENV: "test" })).toThrow(new RegExp(required.join("[\\s\\S]*")));
  });
});

describe("parseDatabaseEnv and parseS3Env malformed values", () => {
  it.each([
    [parseDatabaseEnv, DATABASE, "DATABASE_URL", `mysql://u:${SECRET}@h/db`],
    [parseDatabaseEnv, DATABASE, "DATABASE_URL", `not a url ${SECRET}`],
    [parseS3Env, S3, "S3_ENDPOINT", `ftp://u:${SECRET}@h`],
    [parseS3Env, S3, "S3_ENDPOINT", `nonsense ${SECRET}`],
    [parseS3Env, S3, "S3_REGION", ""],
  ] as const)("rejects malformed %#: %s without echoing its value", (parse, valid, name, value) => {
    const run = () => parse({ NODE_ENV: "test", ...valid, [name]: value });
    expect(run).toThrow(new RegExp(`- ${name}:`));
    expect(run).not.toThrow(SECRET);
    expect(run).not.toThrow(/postgres:|app:/);
  });

  it("defaults S3_REGION to us-east-1 and honours an override", () => {
    expect(parseS3Env({ NODE_ENV: "test", ...S3 }).S3_REGION).toBe("us-east-1");
    expect(parseS3Env({ NODE_ENV: "test", ...S3, S3_REGION: "eu-west-1" }).S3_REGION).toBe(
      "eu-west-1",
    );
  });
});

describe("loadDatabaseEnv and loadS3Env", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("read the ambient environment and fail safely", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", DATABASE.DATABASE_URL);
    for (const [name, value] of Object.entries(S3)) vi.stubEnv(name, value);
    expect(loadDatabaseEnv().DATABASE_URL).toBe(DATABASE.DATABASE_URL);
    expect(loadS3Env().S3_BUCKET).toBe("bucket");
    vi.stubEnv("S3_ENDPOINT", `nonsense ${SECRET}`);
    expect(() => loadS3Env()).toThrow(EnvError);
    expect(() => loadS3Env()).not.toThrow(SECRET);
  });
});
