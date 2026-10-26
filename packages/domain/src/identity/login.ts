import { DomainError } from "../kernel/errors";
import type { SessionId } from "../kernel/ids";
import { parseEmail } from "./email";
import { HashingBusy, InvalidCredentials } from "./errors";
import { parsePassword } from "./password";
import type { CredentialStore, PasswordHasher, SessionStore, User } from "./ports";
import { newSession } from "./session";
import type { SessionTokenHash, SessionTokens } from "./tokens";

export interface LoginDeps {
  readonly credentials: CredentialStore;
  readonly sessions: SessionStore;
  readonly hasher: PasswordHasher;
  readonly tokens: SessionTokens;
  readonly now: () => Date;
  readonly newSessionId: () => SessionId;
  /** Hash of a throwaway password at current parameters, verified for unknown emails. */
  readonly dummyHash: string;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  /** The session the request already carries, if any; it never survives a login. */
  readonly presentedTokenHash: SessionTokenHash | null;
}

function parseCredentials(input: LoginInput) {
  try {
    return { email: parseEmail(input.email), password: parsePassword(input.password) };
  } catch (error) {
    // A shape no account can have (passwords are validated at creation): same answer, no hash.
    if (error instanceof DomainError) throw new InvalidCredentials();
    throw error;
  }
}

/** The raw token is returned once, for the cookie; only its hash is stored. */
export async function login(
  deps: LoginDeps,
  input: LoginInput,
): Promise<{ user: User; token: string }> {
  const { email, password } = parseCredentials(input);
  const stored = await deps.credentials.findByEmail(email);
  // Unknown email verifies against the dummy hash so both paths cost one hash.
  const verified = await deps.hasher.verify(password, stored?.passwordHash ?? deps.dummyHash);
  if (stored === null || !verified) throw new InvalidCredentials();

  const now = deps.now();
  if (deps.hasher.needsRehash(stored.passwordHash)) {
    try {
      await deps.credentials.updatePasswordHash(stored.user, await deps.hasher.hash(password), now);
    } catch (error) {
      // Best effort: a busy hasher must not fail a login that already verified.
      if (!(error instanceof HashingBusy)) throw error;
    }
  }

  // A fresh token on every login: the client never supplies one, so fixation is impossible.
  if (input.presentedTokenHash !== null) await deps.sessions.revoke(input.presentedTokenHash, now);
  await deps.sessions.deleteExpiredForUser(stored.user.id, now);
  const { token, hash } = deps.tokens.generate();
  await deps.sessions.create(newSession(deps.newSessionId(), stored.user.id, now), hash);
  return { user: stored.user, token };
}
