import type { UnitOfWork } from "@contextvault/domain";
import type { Database } from "./client";
import { establishContext } from "./context";
import { createRepositories, type Repositories } from "./repositories/index";

// One transaction per command; context is established before any repository runs.
export function createUnitOfWork(db: Database): UnitOfWork<Repositories> {
  return {
    run: (context, work) =>
      db.transaction(async (tx) => {
        await establishContext(tx, context);
        return work(createRepositories(tx));
      }),
  };
}
