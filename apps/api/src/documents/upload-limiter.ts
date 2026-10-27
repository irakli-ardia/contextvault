import type { UserId } from "@contextvault/domain";
import { ApiError } from "../auth/api-error";

export const MAX_UPLOADS_PER_USER = 2;
export const MAX_UPLOADS_PER_PROCESS = 8;

// In-flight uploads, counted in this process only: a second API process doubles both limits, and
// the keys are user ids (never addresses, which are not trustworthy without a trusted proxy).
// ponytail: move to Redis when the API runs more than one process (M5).
export class UploadLimiter {
  private readonly perUser = new Map<UserId, number>();
  private total = 0;

  /** Uploads holding a slot right now (tests synchronise on it). */
  get active(): number {
    return this.total;
  }

  /** Returns an idempotent release. Throws 429 `upload.busy` when either limit is reached. */
  acquire(userId: UserId): () => void {
    const mine = this.perUser.get(userId) ?? 0;
    if (mine >= MAX_UPLOADS_PER_USER || this.total >= MAX_UPLOADS_PER_PROCESS) {
      throw new ApiError(429, "upload.busy", { "Retry-After": "5" });
    }
    this.perUser.set(userId, mine + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.perUser.get(userId) ?? 1) - 1;
      if (left === 0) this.perUser.delete(userId);
      else this.perUser.set(userId, left);
    };
  }
}
