import type { CredentialStore, SessionStore } from "@contextvault/domain";
import type { Database } from "../client";
import { createCredentialStore } from "./credential-store";
import { createSessionStore } from "./session-store";

export interface AuthStores {
  readonly credentials: CredentialStore;
  readonly sessions: SessionStore;
}

export function createAuthStores(db: Database): AuthStores {
  return { credentials: createCredentialStore(db), sessions: createSessionStore(db) };
}
