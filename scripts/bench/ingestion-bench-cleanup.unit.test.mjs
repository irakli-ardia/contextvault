import { describe, expect, it } from "vitest";
import {
  assertRedisIdentity,
  INGESTION,
  redisSpec,
  removePostgres,
  removeRedis,
  removeRedisLeftovers,
  startRedis,
} from "./ingestion-bench-infra.mjs";
import {
  assertContainerSafe,
  containerSpec,
  removeLeftovers,
  startContainer,
} from "./keyword-experiment-container.mjs";

const compose = `    image: redis:8.2-alpine@sha256:${"a".repeat(64)}\n`;

const fakeDocker = (handlers) => {
  const calls = [];
  const docker = (args) => {
    calls.push(args);
    return (handlers[args[0]] ?? (() => ({ status: 0, stdout: "", stderr: "" })))(args);
  };
  return { docker, calls };
};
const GONE = { status: 1, stdout: "", stderr: "Error: No such container: x" };
const labelled = (kind, run) => ({
  status: 0,
  stdout: JSON.stringify([
    { Config: { Labels: { "cv.experiment": kind, "cv.experiment.run": run } } },
  ]),
  stderr: "",
});

describe("postgres container identity", () => {
  const pg = containerSpec({ profile: INGESTION, id: "0123abcd" });
  const keyword = containerSpec({ id: "0123abcd" });
  it("is named, labelled and database-named for this harness only", () => {
    expect(pg.name).toBe("cv-ingbench-pg-0123abcd");
    expect(pg.database).toBe("cv_ingbench_0123abcd");
    expect(pg.args).toEqual(
      expect.arrayContaining(["cv.experiment=ingestion-bench", "cv.experiment.run=0123abcd"]),
    );
    expect(pg.args).not.toContain("cv.experiment=keyword-search");
    expect(keyword.name).toBe("cv-kwexp-0123abcd");
  });
  it("shares the run id with redis, so one invocation owns both", () => {
    expect(redisSpec({ id: "0123abcd", compose }).name).toBe("cv-ingbench-redis-0123abcd");
  });
  it("is not started beside an ingestion container, but a keyword container does not block it", () => {
    const seen = [];
    const docker = (args) => {
      seen.push(args);
      return { status: 0, stdout: args[0] === "ps" ? "" : "ok", stderr: "" };
    };
    startContainer(docker, pg);
    expect(seen[0]).toEqual(["ps", "-aq", "--filter", "label=cv.experiment=ingestion-bench"]);
    const busy = () => ({ status: 0, stdout: "abc\n", stderr: "" });
    expect(() => startContainer(busy, pg)).toThrow(/cleanup/);
  });
  it("is refused by the safety check when it carries another run's or kind's labels", () => {
    const inspected = (labels) => ({
      Name: `/${pg.name}`,
      Config: { Image: pg.image, Labels: labels, Env: [`POSTGRES_DB=${pg.database}`] },
      HostConfig: { Privileged: false, NetworkMode: "bridge" },
      NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55123" }] } },
      Mounts: [
        { Type: "volume", Destination: "/var/lib/postgresql", RW: true },
        ...pg.binds.map((b) => ({
          Type: "bind",
          Source: b.source,
          Destination: b.target,
          RW: false,
        })),
      ],
    });
    expect(
      assertContainerSafe(
        inspected({ "cv.experiment": "ingestion-bench", "cv.experiment.run": "0123abcd" }),
        pg,
      ),
    ).toBe(55123);
    for (const labels of [
      { "cv.experiment": "keyword-search", "cv.experiment.run": "0123abcd" },
      { "cv.experiment": "ingestion-bench", "cv.experiment.run": "other" },
    ]) {
      expect(() => assertContainerSafe(inspected(labels), pg)).toThrow(/container refused/);
    }
  });
});

describe("cleanup isolation", () => {
  const pg = containerSpec({ profile: INGESTION, id: "0123abcd" });
  const redis = redisSpec({ id: "0123abcd", compose });
  it("removes this run's container and proves it is gone", () => {
    let removed = false;
    const { docker, calls } = fakeDocker({
      inspect: () => (removed ? GONE : labelled("ingestion-bench", "0123abcd")),
      rm: () => {
        removed = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(removePostgres(docker, pg)).toEqual({ removed: true });
    expect(calls.filter((c) => c[0] === "rm")).toEqual([["rm", "-f", "-v", pg.name]]);
  });
  it("leaves a same-named container of another run or kind untouched", () => {
    for (const found of [
      labelled("ingestion-bench", "ffffffff"),
      labelled("keyword-search", "0123abcd"),
    ]) {
      const { docker, calls } = fakeDocker({ inspect: () => found });
      expect(removeRedis(docker, redis).removed).toBe(false);
      expect(calls.some((c) => c[0] === "rm")).toBe(false);
    }
  });
  it("treats an already-removed container as removed without calling rm", () => {
    const { docker, calls } = fakeDocker({ inspect: () => GONE });
    expect(removeRedis(docker, redis)).toEqual({ removed: true });
    expect(calls.some((c) => c[0] === "rm")).toBe(false);
  });
  it.each([
    [
      "an unreachable daemon",
      { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" },
    ],
    ["unreadable inspect output", { status: 0, stdout: "not json", stderr: "" }],
  ])("reports failure, not removal, for %s", (_, answer) => {
    const { docker, calls } = fakeDocker({ inspect: () => answer });
    expect(removePostgres(docker, pg).removed).toBe(false);
    expect(calls.some((c) => c[0] === "rm")).toBe(false);
  });
  it("reports a container that survives rm", () => {
    const { docker } = fakeDocker({
      inspect: () => labelled("ingestion-bench", "0123abcd"),
      rm: () => ({ status: 1, stdout: "", stderr: "busy" }),
    });
    expect(removePostgres(docker, pg)).toMatchObject({
      removed: false,
      detail: expect.stringContaining("busy"),
    });
  });
  it("refuses a name it did not generate", () => {
    const { docker } = fakeDocker({});
    for (const name of ["cv-test-postgres-1", "cv-kwexp-0123abcd", "contextvault-redis-1"]) {
      expect(() => removePostgres(docker, { ...pg, name })).toThrow(/did not name/);
      expect(() => removeRedis(docker, { ...redis, name })).toThrow(/did not name/);
    }
  });
  it("sweeps only labelled, correctly named leftovers", () => {
    const { docker, calls } = fakeDocker({
      ps: () => ({
        status: 0,
        stdout: "cv-ingbench-redis-aaaaaaaa\ncv-test-redis-1\ncv-kwexp-aaaaaaaa\n",
        stderr: "",
      }),
      inspect: () => GONE,
    });
    expect(removeRedisLeftovers(docker)).toEqual([
      { name: "cv-ingbench-redis-aaaaaaaa", removed: true },
    ]);
    expect(calls.filter((c) => c[0] === "rm").map((c) => c.at(-1))).toEqual([
      "cv-ingbench-redis-aaaaaaaa",
    ]);
    const listed = fakeDocker({
      ps: () => ({ status: 0, stdout: "cv-kwexp-aaaaaaaa\ncv-ingbench-pg-bbbbbbbb\n", stderr: "" }),
      inspect: () => GONE,
    });
    expect(removeLeftovers(listed.docker, INGESTION).removed).toEqual(["cv-ingbench-pg-bbbbbbbb"]);
  });
});

describe("redis start and identity", () => {
  const redis = redisSpec({ id: "0123abcd", compose });
  const listing = (stdout) => ({ ps: () => ({ status: 0, stdout, stderr: "" }) });
  it("is not blocked by this run's PostgreSQL container, which shares the label", async () => {
    const { docker, calls } = fakeDocker({
      ...listing("cv-ingbench-pg-0123abcd\n"),
      run: () => ({ status: 1, stdout: "", stderr: "stop here" }),
    });
    await expect(startRedis(docker, redis, "m")).rejects.toThrow(/docker run/);
    expect(calls.some((c) => c[0] === "run")).toBe(true);
  });
  it("refuses to start beside a stale ingestion redis of any run", async () => {
    for (const id of ["0123abcd", "ffffffff"]) {
      const { docker, calls } = fakeDocker(
        listing(`cv-ingbench-pg-0123abcd\ncv-ingbench-redis-${id}\n`),
      );
      await expect(startRedis(docker, redis, "m")).rejects.toThrow(/cleanup/);
      expect(calls.some((c) => c[0] === "run")).toBe(false);
    }
  });
  it("never removes another invocation's redis or any postgres when sweeping", () => {
    const { docker, calls } = fakeDocker({
      ...listing("cv-ingbench-pg-0123abcd\ncv-ingbench-redis-ffffffff\n"),
      inspect: () => labelled("ingestion-bench", "ffffffff"),
    });
    expect(removeRedis(docker, redis).removed).toBe(false);
    expect(calls.some((c) => c[0] === "rm" && c.at(-1) === redis.name)).toBe(false);
    expect(calls.some((c) => c[0] === "rm" && c.at(-1).includes("-pg-"))).toBe(false);
  });
  it("accepts only the planted marker and an otherwise empty database", async () => {
    const client = (marker, size) => ({ get: async () => marker, dbsize: async () => size });
    await expect(assertRedisIdentity(client("m", 1), "m")).resolves.toBeUndefined();
    await expect(assertRedisIdentity(client(null, 0), "m")).rejects.toThrow(/mismatch/);
    await expect(assertRedisIdentity(client("m", 2), "m")).rejects.toThrow(/did not create/);
  });
});

describe("docker failures fail closed", () => {
  const down = { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
  const redis = redisSpec({ id: "0123abcd", compose });
  it("refuses to start redis, or sweep it, when docker ps fails", async () => {
    const { docker, calls } = fakeDocker({ ps: () => down });
    await expect(startRedis(docker, redis, "m")).rejects.toThrow(/docker ps \(redis\) failed/);
    expect(() => removeRedisLeftovers(docker)).toThrow(/Cannot connect/);
    expect(calls.some((c) => c[0] === "run" || c[0] === "rm")).toBe(false);
  });
  it("does not report a redis leftover removed when inspect cannot confirm it is gone", () => {
    const { docker } = fakeDocker({
      ps: () => ({ status: 0, stdout: "cv-ingbench-redis-ffffffff\n", stderr: "" }),
      inspect: () => down,
    });
    expect(removeRedisLeftovers(docker)).toEqual([
      { name: "cv-ingbench-redis-ffffffff", removed: false },
    ]);
  });
  it("does not report removal when inspect fails for any reason but 'no such container'", () => {
    const { docker } = fakeDocker({ inspect: () => down });
    expect(removeRedis(docker, redis).removed).toBe(false);
    expect(
      removePostgres(docker, containerSpec({ profile: INGESTION, id: "0123abcd" })).removed,
    ).toBe(false);
  });
});
