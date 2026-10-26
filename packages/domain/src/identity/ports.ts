import type { UserId } from "../kernel/ids";
import type { Email } from "./email";
import type { Password } from "./password";
import type { Session } from "./session";
import type { SessionTokenHash } from "./tokens";

export interface User {
  readonly id: UserId;
  readonly email: Email;
}

export interface StoredCredential {
  readonly user: User;
  /** Self-describing encoded hash; never logged or returned from an API. */
  readonly passwordHash: string;
}

export interface PasswordHasher {
  hash(password: Password): Promise<string>;
  /** False for a wrong password and for any malformed or unsupported stored hash. */
  verify(password: Password, storedHash: string): Promise<boolean>;
  needsRehash(storedHash: string): boolean;
}

export interface CredentialStore {
  findByEmail(email: Email): Promise<StoredCredential | null>;
  /** False when the user has no credential under this email. */
  updatePasswordHash(user: User, passwordHash: string, now: Date): Promise<boolean>;
}

export interface SessionStore {
  create(session: Session, tokenHash: SessionTokenHash): Promise<void>;
  /** Returns the row whatever its state; `isSessionActive` decides. */
  findByTokenHash(tokenHash: SessionTokenHash): Promise<Session | null>;
  touch(tokenHash: SessionTokenHash, now: Date): Promise<void>;
  revoke(tokenHash: SessionTokenHash, now: Date): Promise<void>;
  revokeAllForUser(userId: UserId, now: Date): Promise<void>;
  /** Removes the user's expired or revoked sessions; returns how many. */
  deleteExpiredForUser(userId: UserId, now: Date): Promise<number>;
}

export interface UserRepository {
  /** Policy-filtered: only the acting user's own row is visible. */
  findById(id: UserId): Promise<User | null>;
}
