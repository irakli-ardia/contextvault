import { describe, expect, it } from "vitest";
import { SATURATION, saturation, startLoadMeter } from "./ingestion-bench-load.mjs";

const fakes = ({ wallMs = 1000, cpuMicros = 500_000, utilization = 0.4 } = {}) => {
  let t = 0;
  let disabled = false;
  return {
    perf: {
      now: () => (t += wallMs),
      eventLoopUtilization: (prev) => (prev ? { utilization } : { idle: 0, active: 0 }),
    },
    monitor: () => ({
      enable() {},
      disable() {
        disabled = true;
      },
      mean: 2e6,
      max: 30e6,
      percentile: () => 9e6,
    }),
    cpuUsage: (prev) =>
      prev ? { user: cpuMicros * 0.75, system: cpuMicros * 0.25 } : { user: 0, system: 0 },
    wasDisabled: () => disabled,
  };
};

describe("startLoadMeter", () => {
  it("reports CPU as cores over wall time and event-loop delay in milliseconds", () => {
    const f = fakes();
    const load = startLoadMeter(f).stop();
    expect(load).toMatchObject({ wallMs: 1000, workerCpuMs: 500, workerCpuCores: 0.5 });
    expect(load.eventLoop).toEqual({
      utilization: 0.4,
      delayMeanMs: 2,
      delayP99Ms: 9,
      delayMaxMs: 30,
    });
    expect(f.wasDisabled()).toBe(true);
  });
});

describe("saturation", () => {
  const load = (utilization, cores, wallMs = 1000) => ({
    wallMs,
    workerCpuCores: cores,
    eventLoop: { utilization },
  });
  it("flags nothing for an unsaturated scenario", () => {
    expect(
      saturation({
        load: load(0.3, 0.4),
        postgresCpuMs: 800,
        postgresIntervalMs: 1000,
        postgresCpuLimit: 2,
      }),
    ).toEqual({ postgresCpuCores: 0.8, saturated: [] });
  });
  it("flags each saturated resource at the threshold", () => {
    const hot = saturation({
      load: load(SATURATION, SATURATION),
      postgresCpuMs: 1800,
      postgresIntervalMs: 1000,
      postgresCpuLimit: 2,
    });
    expect(hot.saturated).toEqual(["worker-event-loop", "worker-cpu", "postgres-cpu"]);
  });
  it("does not guess PostgreSQL CPU when the container exposes none", () => {
    expect(
      saturation({
        load: load(0.1, 0.1),
        postgresCpuMs: null,
        postgresIntervalMs: 1000,
        postgresCpuLimit: 2,
      }),
    ).toEqual({ postgresCpuCores: null, saturated: [] });
  });
});
