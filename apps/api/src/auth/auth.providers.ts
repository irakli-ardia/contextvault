import { randomUUID } from "node:crypto";
import { createPasswordHasher, createSessionTokens } from "@contextvault/auth";
import type { ApiEnv } from "@contextvault/config";
import { createPersistence, type Persistence } from "@contextvault/db";
import {
  type LoginDeps,
  type PasswordHasher,
  parsePassword,
  parseSessionId,
  type SessionDeps,
  type SessionTokens,
} from "@contextvault/domain";
import type { Provider } from "@nestjs/common";
import { ENV, LOGIN_DEPS, PERSISTENCE, SESSION_DEPS, SESSION_TOKENS } from "./tokens";

// The composition root for authentication: concrete adapters are chosen here and nowhere else.
// `hasher` is a seam for tests that need a deterministic hashing capacity.
export function authProviders(
  env: ApiEnv,
  hasher: PasswordHasher = createPasswordHasher(),
): Provider[] {
  return [
    { provide: ENV, useValue: env },
    {
      provide: PERSISTENCE,
      useFactory: (): Persistence & { onModuleDestroy(): Promise<void> } => {
        const persistence = createPersistence({ connectionString: env.DATABASE_URL });
        return { ...persistence, onModuleDestroy: persistence.close };
      },
    },
    { provide: SESSION_TOKENS, useFactory: (): SessionTokens => createSessionTokens() },
    {
      provide: SESSION_DEPS,
      inject: [PERSISTENCE],
      useFactory: (persistence: Persistence): SessionDeps => ({
        sessions: persistence.auth.sessions,
        now: () => new Date(),
      }),
    },
    {
      provide: LOGIN_DEPS,
      inject: [PERSISTENCE, SESSION_TOKENS],
      // One hasher for the process: its concurrency cap (2, queue 8) is shared by every login.
      useFactory: async (persistence: Persistence, tokens: SessionTokens): Promise<LoginDeps> => {
        return {
          credentials: persistence.auth.credentials,
          sessions: persistence.auth.sessions,
          hasher,
          tokens,
          now: () => new Date(),
          newSessionId: () => parseSessionId(randomUUID()),
          // Verified for unknown emails, at current parameters, so both paths cost one hash.
          dummyHash: await hasher.hash(parsePassword(randomUUID())),
        };
      },
    },
  ];
}
