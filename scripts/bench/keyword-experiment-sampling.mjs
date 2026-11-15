// Sampling for the experiment, with its honesty built in: one warm-up that is never counted, then
// up to `runs` timed samples inside a time budget. A timeout or the budget stops sampling but keeps
// every sample already taken, and the result says how many were really collected and why it
// stopped, so a report can never claim more samples than exist.

import { performance } from "node:perf_hooks";
import { isTimeout, stats } from "./retrieval-timing.mjs";

/** Time spent on timed samples of one statement; a slow statement gets fewer than `runs`. */
export const SAMPLE_BUDGET_MS = 60_000;

/** Wraps a statement so it resolves to its own wall-clock duration. */
export const clocked =
  (fn, now = () => performance.now()) =>
  async () => {
    const start = now();
    await fn();
    return { ms: now() - start };
  };

/**
 * `run` resolves to `{ ms, value }`. Returns `{ requested, collected, stop, warmup, samples, median,
 * min, max, values }`; `stop` is "complete", "budget", "timeout" or "warmup-timeout".
 */
export async function sample(run, { runs, budgetMs = SAMPLE_BUDGET_MS }) {
  const attempt = async () => {
    try {
      return { done: await run() };
    } catch (error) {
      if (isTimeout(error)) return { timeout: true };
      throw error; // any other error is a fault, never a slow sample
    }
  };
  const result = {
    requested: runs,
    collected: 0,
    stop: "complete",
    warmup: null,
    samples: [],
    values: [],
  };
  const warm = await attempt();
  if (warm.timeout) return { ...result, stop: "warmup-timeout", warmup: { timeout: true } };
  result.warmup = { ms: warm.done.ms };
  let spent = 0;
  while (result.samples.length < runs) {
    if (spent >= budgetMs) {
      result.stop = "budget";
      break;
    }
    const next = await attempt();
    if (next.timeout) {
      result.stop = "timeout";
      break;
    }
    spent += next.done.ms;
    result.samples.push(next.done.ms);
    result.values.push(next.done.value);
  }
  result.collected = result.samples.length;
  if (result.collected === 0) return result;
  const { median, min, max } = stats(result.samples);
  return { ...result, median, min, max };
}

/** The value of the sample whose time is closest to the median (a plan that really ran). */
export function nearestToMedian({ samples, values, median }) {
  let best = 0;
  samples.forEach((ms, i) => {
    if (Math.abs(ms - median) < Math.abs(samples[best] - median)) best = i;
  });
  return values[best];
}

/** The part of a sample result that belongs in the report (no raw values). */
export const sampleSummary = ({ values: _values, ...rest }) => rest;
