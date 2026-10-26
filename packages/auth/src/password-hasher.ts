import { randomBytes, timingSafeEqual } from "node:crypto";
import type { PasswordHasher } from "@contextvault/domain";
import { derive } from "./argon2";
import { currentParams, formatHash, isBelowCurrent, parseHash, saltBytes, tagBytes } from "./phc";
import { Semaphore } from "./semaphore";

export function createPasswordHasher(
  options: { concurrency?: number; maxQueue?: number } = {},
): PasswordHasher {
  const gate = new Semaphore(options.concurrency ?? 2, options.maxQueue ?? 8);

  return {
    async hash(password) {
      const salt = randomBytes(saltBytes);
      const tag = await gate.run(() =>
        derive(Buffer.from(password, "utf8"), salt, currentParams, tagBytes),
      );
      return formatHash(currentParams, salt, tag);
    },

    async verify(password, storedHash) {
      const stored = parseHash(storedHash);
      if (stored === null) return false;
      const tag = await gate.run(() =>
        derive(Buffer.from(password, "utf8"), stored.salt, stored.params, stored.tag.length),
      );
      return timingSafeEqual(tag, stored.tag);
    },

    needsRehash(storedHash) {
      const stored = parseHash(storedHash);
      return stored !== null && isBelowCurrent(stored.params);
    },
  };
}
