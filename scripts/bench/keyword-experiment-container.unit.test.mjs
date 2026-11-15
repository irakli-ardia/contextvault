import { describe, expect, it } from "vitest";
import {
  assertContainerSafe,
  containerSpec,
  migrationSql,
  pinnedImage,
  removeContainer,
  removeLeftovers,
  startContainer,
} from "./keyword-experiment-container.mjs";

let counter = 0;
const spec = containerSpec({
  id: "0a1b2c3d",
  secret: () => {
    counter += 1;
    return `secret-value-${counter}`;
  },
});

/** What `docker inspect` reports for a container that matches the spec. */
const inspected = (patch = {}) => ({
  Name: `/${spec.name}`,
  Config: {
    Image: spec.image,
    Labels: { "cv.experiment": "keyword-search" },
    Env: [`POSTGRES_DB=${spec.database}`, "POSTGRES_USER=postgres"],
  },
  HostConfig: { Privileged: false, NetworkMode: "bridge" },
  NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55123" }] } },
  Mounts: [
    { Type: "volume", Destination: "/var/lib/postgresql", RW: true },
    ...spec.binds.map((b) => ({
      Type: "bind",
      Source: b.source,
      Destination: b.target,
      RW: false,
    })),
  ],
  ...patch,
});

describe("container spec", () => {
  it("publishes to loopback on an ephemeral port and mounts nothing from the host but the role scripts", () => {
    const { args } = spec;
    expect(args).toContain("127.0.0.1::5432");
    expect(args.filter((a) => a === "--volume")).toHaveLength(4);
    expect(args.filter((a) => a.endsWith(":ro"))).toHaveLength(3);
    expect(args).toContain("--rm");
    expect(args).toContain("--pull=never");
    expect(args.at(-1)).toBe(spec.image);
  });

  it("carries secrets by variable name only", () => {
    const text = spec.args.join(" ");
    for (const value of Object.values(spec.secrets)) expect(text).not.toContain(value);
    expect(Object.keys(spec.secrets)).toHaveLength(5);
    expect(new Set(Object.values(spec.secrets)).size).toBe(5);
  });

  it("uses the image the development stack pins", () => {
    expect(spec.image).toMatch(/^pgvector\/pgvector:.+@sha256:[0-9a-f]{64}$/);
    expect(() => pinnedImage("image: postgres:18")).toThrow(/pinned/);
  });

  it("names are unique per run and match the removal pattern", () => {
    expect(containerSpec().name).not.toBe(containerSpec().name);
    expect(spec.name).toBe("cv-kwexp-0a1b2c3d");
  });

  it("reads every migration, in order", () => {
    const sql = migrationSql();
    expect(sql.indexOf("CREATE TABLE")).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf('"chunks"')).toBeLessThan(sql.indexOf("chunk_embeddings"));
  });
});

describe("assertContainerSafe", () => {
  it("returns the published port of a conforming container", () => {
    expect(assertContainerSafe(inspected(), spec)).toBe(55123);
  });

  it.each([
    [
      "a public bind",
      { NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "55123" }] } } },
    ],
    [
      "the development port",
      { NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5432" }] } } },
    ],
    [
      "an extra published port",
      {
        NetworkSettings: {
          Ports: {
            "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55123" }],
            "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "1" }],
          },
        },
      },
    ],
    ["privileged mode", { HostConfig: { Privileged: true, NetworkMode: "bridge" } }],
    ["host networking", { HostConfig: { Privileged: false, NetworkMode: "host" } }],
    ["another image", { Config: { ...inspected().Config, Image: "postgres:18" } }],
    ["a missing label", { Config: { ...inspected().Config, Labels: {} } }],
    ["another database", { Config: { ...inspected().Config, Env: ["POSTGRES_DB=contextvault"] } }],
    ["another name", { Name: "/contextvault-postgres-1" }],
    [
      "a host data directory",
      {
        Mounts: [
          { Type: "bind", Source: "/data", Destination: "/var/lib/postgresql", RW: true },
          ...inspected().Mounts.slice(1),
        ],
      },
    ],
    [
      "a writable script mount",
      { Mounts: inspected().Mounts.map((m) => (m.Type === "bind" ? { ...m, RW: true } : m)) },
    ],
    [
      "an extra mount",
      {
        Mounts: [
          ...inspected().Mounts,
          { Type: "bind", Source: "/", Destination: "/host", RW: false },
        ],
      },
    ],
  ])("refuses %s", (_label, patch) => {
    expect(() => assertContainerSafe(inspected(patch), spec)).toThrow(/container refused/);
  });
});

/** A fake docker: records calls, answers by subcommand. */
const fakeDocker = (answers = {}) => {
  const calls = [];
  const docker = (args) => {
    calls.push(args);
    const answer = answers[args[0]] ?? { status: 0, stdout: "" };
    return typeof answer === "function" ? answer(args) : answer;
  };
  return { docker, calls };
};

describe("lifecycle", () => {
  it("refuses to start beside a leftover experiment container", () => {
    const { docker, calls } = fakeDocker({ ps: { status: 0, stdout: "abc123\n" } });
    expect(() => startContainer(docker, spec)).toThrow(/cleanup/);
    expect(calls.some((c) => c[0] === "run")).toBe(false);
  });

  it("starts with the spec's arguments and secrets in the child environment only", () => {
    const seen = [];
    const docker = (args, options) => {
      seen.push([args, options]);
      return { status: 0, stdout: "" };
    };
    startContainer(docker, spec);
    expect(seen.at(-1)[0]).toEqual(spec.args);
    expect(seen.at(-1)[1].env).toEqual(spec.secrets);
  });

  const gone = { status: 1, stdout: "", stderr: "Error: No such container: x" };

  it("reports removal only after inspect says the container does not exist", () => {
    const { docker, calls } = fakeDocker({
      rm: { status: 0, stdout: "", stderr: "" },
      inspect: gone,
    });
    expect(removeContainer(docker, spec.name)).toEqual({ removed: true });
    expect(calls[0]).toEqual(["rm", "-f", "-v", spec.name]);
    expect(calls[1]).toEqual(["inspect", "--type", "container", spec.name]);
    expect(() => removeContainer(docker, "contextvault-postgres-1")).toThrow(/did not name/);
  });

  it.each([
    ["still present", { status: 0, stdout: "[{}]", stderr: "" }],
    ["a daemon error", { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }],
    ["an empty error", { status: 1, stdout: "", stderr: "" }],
  ])("does not report removal when inspect shows %s", (_label, inspect) => {
    const { docker } = fakeDocker({ rm: { status: 1, stdout: "", stderr: "rm failed" }, inspect });
    const result = removeContainer(docker, spec.name);
    expect(result.removed).toBe(false);
    expect(result.detail).toMatch(/rm: rm failed/);
  });

  it("cleanup skips labelled containers whose names are not the harness's and reports failures", () => {
    const { docker, calls } = fakeDocker({
      ps: { status: 0, stdout: "cv-kwexp-0a1b2c3d\ncv-kwexp-1b2c3d4e\ncontextvault-postgres-1\n" },
      rm: { status: 0, stdout: "", stderr: "" },
      inspect: (args) =>
        args.at(-1) === "cv-kwexp-0a1b2c3d" ? gone : { status: 0, stdout: "[{}]", stderr: "" },
    });
    const result = removeLeftovers(docker);
    expect(result.removed).toEqual(["cv-kwexp-0a1b2c3d"]);
    expect(result.failed.map((f) => f.name)).toEqual(["cv-kwexp-1b2c3d4e"]);
    expect(calls.filter((c) => c[0] === "rm")).toHaveLength(2);
  });
});
