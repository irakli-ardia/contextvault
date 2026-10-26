import { parseSessionId, parseUserId } from "../kernel/ids";
import { parseEmail } from "./email";
import { HashingBusy } from "./errors";
import type { LoginDeps } from "./login";
import type { CredentialStore, PasswordHasher, SessionStore, User } from "./ports";
import type { Session } from "./session";
import { parseSessionTokenHash, type SessionTokenHash } from "./tokens";

// Deterministic ids keep this file free of node:crypto, which the domain must not import.
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

// In-memory ports for use-case tests. Hash "verification" is string equality on `h:<password>`.
export const user: User = {
  id: parseUserId(uuid(1)),
  email: parseEmail("ada@example.test"),
};
export const goodPassword = "correct horse battery";
export const tokenHash = (n: number): SessionTokenHash =>
  parseSessionTokenHash(n.toString(16).padStart(64, "0"));

export function fakeDeps(options: { stale?: boolean; busyOnHash?: boolean } = {}) {
  const sessions = new Map<SessionTokenHash, Session>();
  const calls: string[] = [];
  const stored = { passwordHash: `h:${goodPassword}` };
  let counter = 0;
  let idCounter = 0;
  const hasher: PasswordHasher = {
    hash: async (p) => {
      if (options.busyOnHash) throw new HashingBusy();
      return `h:${p}`;
    },
    verify: async (p, hash) => {
      calls.push("verify");
      return hash === `h:${p}`;
    },
    needsRehash: () => options.stale === true,
  };
  const credentials: CredentialStore = {
    findByEmail: async (email) => (email === user.email ? { user, ...stored } : null),
    updatePasswordHash: async (_u, hash) => {
      stored.passwordHash = hash;
      calls.push("rehash");
      return true;
    },
  };
  const store: SessionStore = {
    create: async (s, h) => void sessions.set(h, s),
    findByTokenHash: async (h) => sessions.get(h) ?? null,
    touch: async (h, now) => {
      const s = sessions.get(h);
      if (s) sessions.set(h, { ...s, lastSeenAt: now });
      calls.push("touch");
    },
    revoke: async (h, now) => {
      calls.push("revoke");
      const s = sessions.get(h);
      if (s) sessions.set(h, { ...s, revokedAt: now });
    },
    revokeAllForUser: async () => undefined,
    deleteExpiredForUser: async () => 0,
  };
  let clock = new Date("2026-01-01T00:00:00Z");
  const deps: LoginDeps = {
    credentials,
    sessions: store,
    hasher,
    tokens: {
      generate: () => ({ token: `token-${++counter}`, hash: tokenHash(counter) }),
      hash: () => null,
    },
    now: () => clock,
    newSessionId: () => parseSessionId(uuid(100 + ++idCounter)),
    dummyHash: "h:dummy-never-matches",
  };
  return {
    deps,
    sessions,
    calls,
    stored,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
