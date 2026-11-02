import { maxAttempts } from "./lifecycle";

export const leaseDurationMs = 300_000;
export const redriveBaseCooldownMs = 300_000;
export const redriveMaxCooldownMs = 21_600_000;
// 2^7 x 5 min already exceeds the cap, so a larger exponent changes nothing.
const maxCooldownExponent = 7;

/**
 * Outbox rows beyond this change no cooldown: the exponent saturates at `rows - 1 - attempt >= 7`
 * and `attempt <= maxAttempts`. Adapters count at most this many rows.
 */
export const outboxHistoryCap = maxCooldownExponent + 1 + maxAttempts;

// NaN, infinities, negatives and fractions collapse to a whole count >= 0.
const count = (n: number | undefined): number =>
  n === undefined || !Number.isFinite(n) ? 0 : Math.max(0, Math.trunc(n));

/**
 * Wait before re-driving an orphaned version, given the outbox rows it has already burned and the
 * attempts consumed. Shapes scheduling only: it never decides who owns the version.
 */
export function redriveCooldownMs(outboxRows?: number, attempt?: number): number {
  const rest = Math.max(0, count(outboxRows) - 1 - count(attempt));
  return Math.min(
    redriveMaxCooldownMs,
    redriveBaseCooldownMs * 2 ** Math.min(rest, maxCooldownExponent),
  );
}
