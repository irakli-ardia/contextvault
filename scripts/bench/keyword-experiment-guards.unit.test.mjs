import { describe, expect, it } from "vitest";
import { assertLocalDocker, installSignalCleanup } from "./keyword-experiment-guards.mjs";

const docker = (context) => {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    if (args[1] === "show") return { status: 0, stdout: `${context.name}\n`, stderr: "" };
    return { status: context.status ?? 0, stdout: `${context.host}\n`, stderr: "" };
  };
  return { fn, calls };
};

describe("assertLocalDocker", () => {
  it.each(["unix:///var/run/docker.sock", "unix:///Users/someone/.docker/run/docker.sock"])(
    "accepts DOCKER_HOST %s without asking docker",
    (host) => {
      const { fn, calls } = docker({ name: "x", host: "ignored" });
      expect(() => assertLocalDocker({ docker: fn, env: { DOCKER_HOST: host } })).not.toThrow();
      expect(calls).toEqual([]);
    },
  );

  it.each([
    "tcp://10.0.0.5:2375",
    "tcp://127.0.0.1:2375",
    "ssh://deploy@build-host",
    "npipe:////./pipe/docker_engine",
    "unix://relative.sock",
    "http://x",
  ])("refuses DOCKER_HOST %s", (host) => {
    const { fn } = docker({ name: "x", host: "unix:///var/run/docker.sock" });
    expect(() => assertLocalDocker({ docker: fn, env: { DOCKER_HOST: host } })).toThrow(/refused/);
  });

  it("accepts a local active context (DOCKER_CONTEXT is resolved by the CLI itself)", () => {
    const { fn, calls } = docker({
      name: "desktop-linux",
      host: "unix:///Users/x/.docker/run/docker.sock",
    });
    expect(() =>
      assertLocalDocker({ docker: fn, env: { DOCKER_CONTEXT: "desktop-linux" } }),
    ).not.toThrow();
    expect(calls[0]).toEqual(["context", "show"]);
    expect(calls[1].slice(0, 3)).toEqual(["context", "inspect", "desktop-linux"]);
  });

  it.each([
    ["an ssh context", { name: "prod", host: "ssh://deploy@host" }],
    ["a tcp context", { name: "ci", host: "tcp://ci:2376" }],
    ["a context that cannot be inspected", { name: "x", host: "", status: 1 }],
    ["an empty endpoint", { name: "x", host: "" }],
  ])("refuses %s", (_label, context) => {
    const { fn } = docker(context);
    expect(() => assertLocalDocker({ docker: fn, env: {} })).toThrow(/refused/);
  });

  it("refuses when no active context can be read", () => {
    const fn = () => ({ status: 1, stdout: "", stderr: "daemon" });
    expect(() => assertLocalDocker({ docker: fn, env: {} })).toThrow("no active context");
  });
});

describe("installSignalCleanup", () => {
  const fakeProcess = () => {
    const handlers = new Map();
    const exits = [];
    return {
      handlers,
      exits,
      on: (signal, fn) => handlers.set(signal, fn),
      off: (signal) => handlers.delete(signal),
      exit: (code) => exits.push(code),
    };
  };

  it("handles SIGINT, SIGTERM and SIGHUP", () => {
    const proc = fakeProcess();
    installSignalCleanup(() => {}, proc);
    expect([...proc.handlers.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
      "SIGHUP",
      "SIGINT",
      "SIGTERM",
    ]);
  });

  it("cleans up once, then exits with the signal's code; repeats are ignored", () => {
    const proc = fakeProcess();
    const seen = [];
    installSignalCleanup((signal) => seen.push(signal), proc);
    proc.handlers.get("SIGTERM")();
    proc.handlers.get("SIGINT")();
    expect(seen).toEqual(["SIGTERM"]);
    expect(proc.exits).toEqual([143]);
  });

  it("still exits when cleanup throws", () => {
    const proc = fakeProcess();
    installSignalCleanup(() => {
      throw new Error("boom");
    }, proc);
    expect(() => proc.handlers.get("SIGINT")()).toThrow(/boom/);
    expect(proc.exits).toEqual([130]);
  });

  it("removes its handlers", () => {
    const proc = fakeProcess();
    installSignalCleanup(() => {}, proc)();
    expect(proc.handlers.size).toBe(0);
  });
});
