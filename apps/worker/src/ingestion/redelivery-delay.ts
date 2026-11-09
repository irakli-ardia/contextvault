const maxDelayMs = 60_000;
// 2 ** 16 already saturates the cap for any sane base; bounding the exponent keeps the product finite.
const maxDoublings = 16;

/**
 * Delay before a job that never reached a claim is delivered again: `baseMs` doubling with each
 * delivery (`attemptsStarted` counts the current one, from 1), capped at 60 s, then "equal jitter"
 * keeps the upper half so the result never exceeds the cap and retries still spread out.
 * `random` returns a number in [0, 1).
 */
export function redeliveryDelayMs(
  baseMs: number,
  attemptsStarted: number | undefined,
  random: () => number,
): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0;
  const delivery =
    Number.isInteger(attemptsStarted) && (attemptsStarted ?? 0) > 0 ? (attemptsStarted ?? 1) : 1;
  const ceiling = Math.min(maxDelayMs, base * 2 ** Math.min(delivery - 1, maxDoublings));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.floor(ceiling / 2 + (ceiling / 2) * (Number.isFinite(r) ? r : 0));
}
