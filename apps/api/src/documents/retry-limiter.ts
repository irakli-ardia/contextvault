import type { UserId } from "@contextvault/domain";
import { ApiError } from "../http/api-error";

export const MAX_RETRIES_PER_USER = 5;
export const RETRY_WINDOW_MS = 60_000;
const maxKeys = 10_000;

interface Entry {
  count: number;
  windowStart: number;
}

// Every attempt counts, accepted or refused: a 404 or 409 costs a transaction too, and each
// accepted retry buys a fresh attempt budget of parse work. Per user id (never an address, which
// is not trustworthy without a trusted proxy). Time is injected so tests need no sleeps.
// ponytail: in-process fixed window, valid for ONE api instance only (same ceiling as
// UploadLimiter and LoginLimiter); move to Redis with them when the API runs more than one process.
export class RetryLimiter {
  private readonly entries = new Map<UserId, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts this attempt. Throws 429 `retry.throttled` once the window's allowance is spent. */
  take(userId: UserId): void {
    const now = this.now();
    const current = this.entries.get(userId);
    const entry =
      current !== undefined && now < current.windowStart + RETRY_WINDOW_MS
        ? current
        : { count: 0, windowStart: now };
    if (entry.count >= MAX_RETRIES_PER_USER) {
      const waitMs = entry.windowStart + RETRY_WINDOW_MS - now;
      throw new ApiError(429, "retry.throttled", {
        "Retry-After": String(Math.max(1, Math.ceil(waitMs / 1000))),
      });
    }
    entry.count += 1;
    this.entries.delete(userId);
    this.entries.set(userId, entry);
    // Oldest-first eviction keeps memory bounded under a flood of distinct users.
    if (this.entries.size > maxKeys) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }
}
