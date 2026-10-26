const windowMs = 15 * 60_000;
const maxKeys = 10_000;

interface Entry {
  count: number;
  windowStart: number;
  blockedUntil: number;
}

export interface LimitPolicy {
  /** Failures tolerated per window before blocking starts. */
  readonly limit: number;
  /** First block length; doubles with each further failure, capped at the window. */
  readonly baseDelayMs: number;
}

export const ipPolicy: LimitPolicy = { limit: 20, baseDelayMs: windowMs };
export const accountPolicy: LimitPolicy = { limit: 5, baseDelayMs: 30_000 };

// ponytail: in-process fixed-window counters, valid for ONE api instance only. A restart resets
// them and each extra instance multiplies the allowance; the multi-instance path is a Redis-backed
// limiter behind this same shape, in its own approved increment.
export class LoginLimiter {
  private readonly entries = new Map<string, Entry>();

  /** Seconds to wait when any key is blocked, otherwise null. */
  retryAfterSeconds(keys: readonly string[], now: number): number | null {
    let waitMs = 0;
    for (const key of keys) {
      const entry = this.live(key, now);
      if (entry !== undefined) waitMs = Math.max(waitMs, entry.blockedUntil - now);
    }
    return waitMs > 0 ? Math.ceil(waitMs / 1000) : null;
  }

  recordFailure(key: string, policy: LimitPolicy, now: number): void {
    const entry = this.live(key, now) ?? { count: 0, windowStart: now, blockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= policy.limit) {
      const delay = Math.min(windowMs, policy.baseDelayMs * 2 ** (entry.count - policy.limit));
      entry.blockedUntil = now + delay;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    // Oldest-first eviction keeps memory bounded under a flood of distinct keys.
    if (this.entries.size > maxKeys) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  private live(key: string, now: number): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (now >= Math.max(entry.windowStart + windowMs, entry.blockedUntil)) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
