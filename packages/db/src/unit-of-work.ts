import { TransactionOutcomeUnknown, type UnitOfWork } from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Database, Executor } from "./client";
import { establishContext } from "./context";
import { createRepositories, type Repositories } from "./repositories/index";
import { postgresErrorCode } from "./repositories/workspaces/postgres-error";

// Transaction-local, like the tenant context: the bound vanishes at commit or rollback and a
// pooled connection never carries it to the next borrower. `statement_timeout` also ends a wait
// for an advisory or row lock (that wait is part of the statement), so no `lock_timeout` is needed.
export async function applyTimeout(tx: Executor, timeoutMs: number): Promise<void> {
  await tx.execute(
    sql`select set_config('statement_timeout', ${String(Math.trunc(timeoutMs))}, true)`,
  );
}

// One transaction per command; context is established before any repository runs. An error that
// reaches the caller after `work` succeeded came from COMMIT: with a SQLSTATE the server refused
// it, without one the connection was lost and the commit may still have happened.
export async function runTransaction<T>(
  db: Database,
  timeoutMs: number | undefined,
  establish: (tx: Executor) => Promise<void>,
  work: (tx: Executor) => Promise<T>,
): Promise<T> {
  let worked = false;
  try {
    return await db.transaction(async (tx) => {
      if (timeoutMs !== undefined) await applyTimeout(tx, timeoutMs);
      await establish(tx);
      const result = await work(tx);
      worked = true;
      return result;
    });
  } catch (error) {
    if (worked && postgresErrorCode(error) === undefined) {
      throw new TransactionOutcomeUnknown({ cause: error });
    }
    throw error;
  }
}

export function createUnitOfWork(db: Database): UnitOfWork<Repositories> {
  return {
    run: (context, work, options) =>
      runTransaction(
        db,
        options?.timeoutMs,
        (tx) => establishContext(tx, context),
        (tx) => work(createRepositories(tx)),
      ),
  };
}
