import type { UnitOfWork } from "@contextvault/domain";
import { type AuthStores, createAuthStores } from "./auth/index";
import { createDatabase } from "./client";
import { assertLeastPrivilege } from "./privilege-check";
import type { Repositories } from "./repositories/index";
import { createUnitOfWork } from "./unit-of-work";

export interface Persistence {
  readonly unitOfWork: UnitOfWork<Repositories>;
  /** Pre-identity access (login, session lookup) through the two presented proofs. */
  readonly auth: AuthStores;
  /** Startup guard: refuses a role that RLS does not bind. */
  readonly assertLeastPrivilege: () => Promise<void>;
  readonly close: () => Promise<void>;
}

// The only way in. No raw client is exposed: tenant queries run inside unitOfWork.run, after the
// tenant context is set; identity queries run inside the auth stores, after their proof is set.
export function createPersistence(options: {
  connectionString: string;
  poolSize?: number;
}): Persistence {
  const { db, close } = createDatabase(options);
  return {
    unitOfWork: createUnitOfWork(db),
    auth: createAuthStores(db),
    assertLeastPrivilege: () => assertLeastPrivilege(db),
    close,
  };
}

export type { AuthStores } from "./auth/index";
