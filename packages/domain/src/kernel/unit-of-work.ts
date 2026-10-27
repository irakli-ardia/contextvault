import type { UserId, WorkspaceId } from "./ids";

// Who is acting, as established by the caller's session. A workspace id is a claim, not proof:
// the adapter rejects it unless the user is a member.
export interface TenantContext {
  readonly userId: UserId;
  readonly workspaceId?: WorkspaceId;
}

export interface UnitOfWorkOptions {
  /**
   * Bounds every statement, and every lock wait, of this transaction (the database cancels it with
   * an error and rolls back). Unset means the database default (unbounded).
   */
  readonly timeoutMs?: number;
}

export interface UnitOfWork<Repos> {
  /**
   * Fails with `TransactionOutcomeUnknown` when the connection is lost after COMMIT was sent. Any
   * other failure means the work was rolled back.
   */
  run<T>(
    context: TenantContext,
    work: (repos: Repos) => Promise<T>,
    options?: UnitOfWorkOptions,
  ): Promise<T>;
}
