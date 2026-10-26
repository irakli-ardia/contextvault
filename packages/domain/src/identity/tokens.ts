import { DomainError } from "../kernel/errors";

// SHA-256 of a session token, lowercase hex. The raw token exists only in the cookie.
export type SessionTokenHash = string & { readonly brand: "SessionTokenHash" };

const isSessionTokenHash = (value: string): value is SessionTokenHash =>
  /^[0-9a-f]{64}$/.test(value);

export function parseSessionTokenHash(value: string): SessionTokenHash {
  if (!isSessionTokenHash(value)) {
    throw new DomainError("session.invalid_token_hash", "Invalid session token hash");
  }
  return value;
}

export interface SessionTokens {
  generate(): { token: string; hash: SessionTokenHash };
  /** Hashes a presented (untrusted) token; null when it is not a well-formed token. */
  hash(candidate: string): SessionTokenHash | null;
}
