import { parseUserId } from "@contextvault/domain";
import { describe, expect, it } from "vitest";
import { MAX_UPLOADS_PER_PROCESS, MAX_UPLOADS_PER_USER, UploadLimiter } from "./upload-limiter";

const user = (n: number) => parseUserId(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const busy = { status: 429, code: "upload.busy" };

describe("UploadLimiter", () => {
  it("allows 2 per user and refuses the 3rd", () => {
    const limiter = new UploadLimiter();
    limiter.acquire(user(1));
    limiter.acquire(user(1));
    expect(MAX_UPLOADS_PER_USER).toBe(2);
    expect(() => limiter.acquire(user(1))).toThrowError(expect.objectContaining(busy));
    expect(() => limiter.acquire(user(2))).not.toThrow();
  });

  it("allows 8 per process across users", () => {
    const limiter = new UploadLimiter();
    for (let n = 0; n < MAX_UPLOADS_PER_PROCESS / 2; n++) {
      limiter.acquire(user(n));
      limiter.acquire(user(n));
    }
    expect(limiter.active).toBe(8);
    expect(() => limiter.acquire(user(99))).toThrowError(expect.objectContaining(busy));
  });

  it("a release frees exactly one slot and is idempotent", () => {
    const limiter = new UploadLimiter();
    const release = limiter.acquire(user(1));
    limiter.acquire(user(1));
    release();
    release();
    release();
    expect(limiter.active).toBe(1);
    limiter.acquire(user(1));
    expect(() => limiter.acquire(user(1))).toThrowError(expect.objectContaining(busy));
  });

  it("a refused acquire takes nothing", () => {
    const limiter = new UploadLimiter();
    limiter.acquire(user(1));
    limiter.acquire(user(1));
    expect(() => limiter.acquire(user(1))).toThrow();
    expect(limiter.active).toBe(2);
  });
});
