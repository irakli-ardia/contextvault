// Load on the benchmark's own process and on PostgreSQL during a scenario, so a reader can tell
// work from queuing: client-observed timings include event-loop delay, and a saturated CPU turns
// every one of them into a waiting time.

import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export const SATURATION = 0.9;
const NS_PER_MS = 1e6;

/** Starts metering; `stop()` returns the worker-process load over the interval. */
export function startLoadMeter({
  perf = performance,
  monitor = monitorEventLoopDelay,
  cpuUsage = (previous) => process.cpuUsage(previous),
} = {}) {
  const histogram = monitor({ resolution: 10 });
  histogram.enable();
  const elu = perf.eventLoopUtilization();
  const cpu = cpuUsage();
  const start = perf.now();
  return {
    stop() {
      const wallMs = perf.now() - start;
      const used = cpuUsage(cpu);
      const loop = perf.eventLoopUtilization(elu);
      histogram.disable();
      return {
        wallMs,
        workerCpuMs: (used.user + used.system) / 1000,
        workerCpuCores: wallMs > 0 ? (used.user + used.system) / 1000 / wallMs : null,
        eventLoop: {
          utilization: loop.utilization,
          delayMeanMs: histogram.mean / NS_PER_MS,
          delayP99Ms: histogram.percentile(99) / NS_PER_MS,
          delayMaxMs: histogram.max / NS_PER_MS,
        },
      };
    },
  };
}

/** Which resources were saturated: the worker's event loop or CPU, or PostgreSQL's CPU limit. */
export function saturation({ load, postgresCpuMs, postgresIntervalMs, postgresCpuLimit }) {
  const flags = [];
  if (load.eventLoop.utilization >= SATURATION) flags.push("worker-event-loop");
  if ((load.workerCpuCores ?? 0) >= SATURATION) flags.push("worker-cpu");
  const pgCores =
    postgresCpuMs === null || !(postgresIntervalMs > 0) ? null : postgresCpuMs / postgresIntervalMs;
  if (pgCores !== null && postgresCpuLimit && pgCores / postgresCpuLimit >= SATURATION)
    flags.push("postgres-cpu");
  return { postgresCpuCores: pgCores, saturated: flags };
}
