// Wall-clock measurement for the retrieval benchmark. A statement that hits the role's
// statement_timeout (SQLSTATE 57014) is a result, never a failure of the run, in the warm-up and in
// every measured round alike; any other error still aborts, so a real fault is not recorded as a
// slow statement.

import { performance } from "node:perf_hooks";

export const isTimeout = (error) => error?.code === "57014";

/** A statement over this is repeated only twice: a full ladder at 50k+ chunks would take hours. */
export const SLOW_MS = 2000;

// Conventional median: the mean of the two middle samples for an even count. (The committed
// results.json used the upper middle sample, see docs/retrieval-performance.md.)
const medianOf = (sorted) => {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

export const stats = (times) => {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    median: medianOf(sorted),
    min: sorted[0],
    max: sorted.at(-1),
    runs: times,
  };
};

/**
 * Warm-up, then up to `runs` timed rounds. A timeout in any call returns `{ timeout: true }` with
 * the rounds that did finish in `completedRuns`, so a statement near the limit is reported as a
 * timeout instead of aborting the benchmark hours in.
 */
// fallow-ignore-next-line complexity
export async function wall(fn, runs, now = () => performance.now()) {
  const first = now();
  try {
    await fn();
  } catch (error) {
    if (isTimeout(error)) return { timeout: true, completedRuns: [] };
    throw error;
  }
  const rounds = now() - first > SLOW_MS ? Math.min(runs, 2) : runs;
  const times = [];
  for (let i = 0; i < rounds; i += 1) {
    const start = now();
    try {
      await fn();
    } catch (error) {
      if (isTimeout(error)) return { timeout: true, completedRuns: times };
      throw error;
    }
    times.push(now() - start);
  }
  return stats(times);
}

/** The rows of `fn`, or `{ timeout: true, rows: [] }` when the statement timed out. */
export async function settled(fn) {
  try {
    return { timeout: false, rows: await fn() };
  } catch (error) {
    if (isTimeout(error)) return { timeout: true, rows: [] };
    throw error;
  }
}
