import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EnvError,
  loadDatabaseEnv,
  loadEnv,
  loadMigrationEnv,
  loadS3Env,
  parseApiEnv,
  parseDatabaseEnv,
  parseEnv,
  parseMigrationEnv,
  parseS3Env,
  parseWebEnv,
  parseWorkerDatabaseEnv,
  parseWorkerEnv,
} from "./env";

const SECRET = "s3cr3t-value-must-not-leak";

const DATABASE = { DATABASE_URL: `postgres://app:${SECRET}@127.0.0.1:5432/db` };
const WORKER_DATABASE = {
  DATABASE_WORKER_URL: `postgres://worker:${SECRET}@127.0.0.1:5432/db`,
};
const MIGRATION = { DATABASE_MIGRATION_URL: `postgres://owner:${SECRET}@127.0.0.1:5432/db` };
const S3 = {
  S3_ENDPOINT: "http://127.0.0.1:8333",
  S3_BUCKET: "bucket",
  S3_ACCESS_KEY_ID: "access-key",
  S3_SECRET_ACCESS_KEY: SECRET,
};
const API = {
  NODE_ENV: "test",
  API_PORT: "3001",
  API_HOST: "127.0.0.1",
  WEB_ORIGIN: "http://127.0.0.1:3000",
  ...DATABASE,
  ...S3,
};
const WORKER = { NODE_ENV: "test", REDIS_URL: "redis://localhost:6379", ...WORKER_DATABASE };

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

  it("defaults TRUSTED_PROXY_HOPS to 0 outside production", () => {
    expect(parseApiEnv(API).TRUSTED_PROXY_HOPS).toBe(0);
    expect(parseApiEnv({ ...API, TRUSTED_PROXY_HOPS: "1" }).TRUSTED_PROXY_HOPS).toBe(1);
  });

  it.each(["", "-1", "4", "1.5", "x"])("rejects TRUSTED_PROXY_HOPS=%j", (hops) => {
    expect(() => parseApiEnv({ ...API, TRUSTED_PROXY_HOPS: hops })).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  it.each(["http://x.test/", "http://x.test/app", "http://x.test?q=1", "ftp://x.test", "nope"])(
    "rejects WEB_ORIGIN=%j",
    (origin) => {
      expect(() => parseApiEnv({ ...API, WEB_ORIGIN: origin })).toThrow(/WEB_ORIGIN/);
    },
  );

  it("requires an https WEB_ORIGIN and explicit TRUSTED_PROXY_HOPS in production", () => {
    const prod = { ...API, NODE_ENV: "production", S3_ENDPOINT: "https://s3.example.test" };
    expect(() => parseApiEnv({ ...prod, TRUSTED_PROXY_HOPS: "1" })).toThrow(/WEB_ORIGIN/);
    const secure = { ...prod, WEB_ORIGIN: "https://app.example.test" };
    expect(() => parseApiEnv(secure)).toThrow(/TRUSTED_PROXY_HOPS/);
    expect(parseApiEnv({ ...secure, TRUSTED_PROXY_HOPS: "1" }).TRUSTED_PROXY_HOPS).toBe(1);
  });

  it("requires API_HOST and DATABASE_URL without echoing the secret", () => {
    const { API_HOST: _host, ...noHost } = API;
    expect(() => parseApiEnv(noHost)).toThrow(/API_HOST/);
    const { DATABASE_URL: _url, ...noUrl } = API;
    expect(() => parseApiEnv(noUrl)).toThrow(/DATABASE_URL/);
    expect(() => parseApiEnv({ ...API, DATABASE_URL: `nope-${SECRET}` })).not.toThrow(SECRET);
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

describe("parseWebEnv", () => {
  it("defaults to the loopback development API", () => {
    expect(parseWebEnv({}).API_INTERNAL_URL).toBe("http://127.0.0.1:3001");
  });

  it("accepts a bare origin and rejects paths, credentials, and other schemes", () => {
    expect(parseWebEnv({ API_INTERNAL_URL: "http://api.internal:3001" }).API_INTERNAL_URL).toBe(
      "http://api.internal:3001",
    );
    for (const value of [
      "http://127.0.0.1:3001/",
      "http://127.0.0.1:3001/v1",
      "http://user:pw@127.0.0.1:3001",
      "ftp://127.0.0.1:3001",
      "not a url",
    ]) {
      expect(() => parseWebEnv({ API_INTERNAL_URL: value })).toThrow(EnvError);
    }
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

describe("S3_ENDPOINT shape", () => {
  it.each([
    "http://127.0.0.1:8333/",
    "http://127.0.0.1:8333/bucket",
    "http://127.0.0.1:8333?x=1",
    `http://user:${SECRET}@127.0.0.1:8333`,
  ])("rejects %j as a non-bare origin without echoing it", (endpoint) => {
    expect(() => parseS3Env({ NODE_ENV: "test", ...S3, S3_ENDPOINT: endpoint })).toThrow(
      /S3_ENDPOINT/,
    );
    expect(() => parseS3Env({ NODE_ENV: "test", ...S3, S3_ENDPOINT: endpoint })).not.toThrow(
      SECRET,
    );
  });

  it("requires https in production, for the api too", () => {
    const production = { NODE_ENV: "production", TRUSTED_PROXY_HOPS: "1" };
    expect(() => parseS3Env({ ...S3, NODE_ENV: "production" })).toThrow(/S3_ENDPOINT/);
    expect(() => parseApiEnv({ ...API, ...production, WEB_ORIGIN: "https://app.test" })).toThrow(
      /S3_ENDPOINT/,
    );
    const https = { ...S3, S3_ENDPOINT: "https://s3.example.test", NODE_ENV: "production" };
    expect(() => parseS3Env(https)).not.toThrow();
  });
});

describe("app schemas stay independent of what they do not read", () => {
  it("the worker parses without DATABASE_URL or S3_*", () => {
    expect(parseWorkerEnv(WORKER)).toEqual(WORKER);
  });

  it("the worker ignores malformed DATABASE_URL and S3_* values", () => {
    const bad = { DATABASE_URL: "nonsense", S3_ENDPOINT: "nonsense", S3_BUCKET: "" };
    expect(() => parseWorkerEnv({ ...WORKER, ...bad })).not.toThrow();
  });

  it.each(["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])(
    "the api requires %s",
    (name) => {
      expect(() => parseApiEnv({ ...API, [name]: undefined })).toThrow(name);
    },
  );

  it("the api never reads the owner-role migration URL", () => {
    expect(parseApiEnv({ ...API, ...MIGRATION })).not.toHaveProperty("DATABASE_MIGRATION_URL");
  });
});

describe.each([
  ["parseDatabaseEnv", parseDatabaseEnv, { NODE_ENV: "test", ...DATABASE }, Object.keys(DATABASE)],
  [
    "parseMigrationEnv",
    parseMigrationEnv,
    { NODE_ENV: "test", ...MIGRATION },
    Object.keys(MIGRATION),
  ],
  [
    "parseWorkerDatabaseEnv",
    parseWorkerDatabaseEnv,
    { NODE_ENV: "test", ...WORKER_DATABASE },
    Object.keys(WORKER_DATABASE),
  ],
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
    [parseMigrationEnv, MIGRATION, "DATABASE_MIGRATION_URL", `mysql://u:${SECRET}@h/db`],
    [parseS3Env, S3, "S3_ENDPOINT", `ftp://u:${SECRET}@h`],
    [parseS3Env, S3, "S3_ENDPOINT", `nonsense ${SECRET}`],
    [parseS3Env, S3, "S3_REGION", ""],
  ] as const)("rejects malformed %#: %s without echoing its value", (parse, valid, name, value) => {
    const run = () => parse({ NODE_ENV: "test", ...valid, [name]: value });
    expect(run).toThrow(new RegExp(`- ${name}:`));
    expect(run).not.toThrow(SECRET);
    expect(run).not.toThrow(/postgres:|app:|owner:/);
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
    vi.stubEnv("DATABASE_MIGRATION_URL", MIGRATION.DATABASE_MIGRATION_URL);
    expect(loadMigrationEnv().DATABASE_MIGRATION_URL).toBe(MIGRATION.DATABASE_MIGRATION_URL);
    vi.stubEnv("S3_ENDPOINT", `nonsense ${SECRET}`);
    expect(() => loadS3Env()).toThrow(EnvError);
    expect(() => loadS3Env()).not.toThrow(SECRET);
  });
});
