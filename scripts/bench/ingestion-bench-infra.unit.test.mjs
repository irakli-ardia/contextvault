import { describe, expect, it } from "vitest";
import { assertRedisSafe, redisSpec } from "./ingestion-bench-infra.mjs";

const DIGEST = "a".repeat(64);
const compose = `    image: redis:8.2-alpine@sha256:${DIGEST}\n`;
const spec = redisSpec({ id: "0123abcd", compose });
const inspect = (over = {}) => ({
  Name: `/${spec.name}`,
  Config: {
    Image: spec.image,
    Labels: { "cv.experiment": "ingestion-bench", "cv.experiment.run": "0123abcd" },
  },
  HostConfig: { Privileged: false, NetworkMode: "bridge" },
  Mounts: [{ Type: "volume" }],
  NetworkSettings: { Ports: { "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: "49155" }] } },
  ...over,
});

describe("redisSpec", () => {
  it("is pinned, loopback-only, mount-free and carries no secret", () => {
    expect(spec.image).toBe(`redis:8.2-alpine@sha256:${DIGEST}`);
    expect(spec.args).toContain("127.0.0.1::6379");
    expect(spec.args).not.toContain("--volume");
    expect(spec.args).toEqual(
      expect.arrayContaining(["--pull=never", "--rm", "--appendonly", "no"]),
    );
  });
  it("refuses a compose file without a pinned image", () => {
    expect(() => redisSpec({ compose: "image: redis:latest" })).toThrow("no pinned redis image");
  });
});

describe("assertRedisSafe", () => {
  it("returns the published loopback port", () =>
    expect(assertRedisSafe(inspect(), spec)).toBe(49155));
  it.each([
    [
      "a non-loopback bind",
      { NetworkSettings: { Ports: { "6379/tcp": [{ HostIp: "0.0.0.0", HostPort: "49155" }] } } },
    ],
    [
      "the development port",
      { NetworkSettings: { Ports: { "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: "6379" }] } } },
    ],
    ["a host bind mount", { Mounts: [{ Type: "bind" }] }],
    ["privileges", { HostConfig: { Privileged: true } }],
    ["another container's name", { Name: "/cv-test-redis-1" }],
    [
      "another kind label",
      {
        Config: {
          Image: spec.image,
          Labels: { "cv.experiment": "keyword-search", "cv.experiment.run": "0123abcd" },
        },
      },
    ],
    [
      "another run's label",
      {
        Config: {
          Image: spec.image,
          Labels: { "cv.experiment": "ingestion-bench", "cv.experiment.run": "ffffffff" },
        },
      },
    ],
    ["host networking", { HostConfig: { Privileged: false, NetworkMode: "host" } }],
  ])("refuses %s", (_, over) =>
    expect(() => assertRedisSafe(inspect(over), spec)).toThrow("refused"),
  );
});
