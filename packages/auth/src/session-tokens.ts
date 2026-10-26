import { createHash, randomBytes } from "node:crypto";
import { parseSessionTokenHash, type SessionTokens } from "@contextvault/domain";

// 32 random bytes as 43 base64url characters; only the SHA-256 is ever stored.
const tokenShape = /^[A-Za-z0-9_-]{43}$/;
const hashOf = (token: string) =>
  parseSessionTokenHash(createHash("sha256").update(token).digest("hex"));

export function createSessionTokens(): SessionTokens {
  return {
    generate() {
      const token = randomBytes(32).toString("base64url");
      return { token, hash: hashOf(token) };
    },
    hash: (candidate) => (tokenShape.test(candidate) ? hashOf(candidate) : null),
  };
}
