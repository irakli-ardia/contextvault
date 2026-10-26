import type { UnitOfWork } from "@contextvault/domain";
import { createDatabase } from "./client";
import type { Repositories } from "./repositories/index";
import { createUnitOfWork } from "./unit-of-work";

export interface Persistence {
  readonly unitOfWork: UnitOfWork<Repositories>;
  readonly close: () => Promise<void>;
}

// The only way in. No raw client is exposed: every query runs inside unitOfWork.run, after the
// tenant context is set.
export function createPersistence(options: {
  connectionString: string;
  poolSize?: number;
}): Persistence {
  const { db, close } = createDatabase(options);
  return { unitOfWork: createUnitOfWork(db), close };
}

export type { Repositories } from "./repositories/index";
