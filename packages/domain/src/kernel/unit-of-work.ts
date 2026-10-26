import type { UserId, WorkspaceId } from "./ids";

// Who is acting, as established by the caller's session. A workspace id is a claim, not proof:
// the adapter rejects it unless the user is a member.
export interface TenantContext {
  readonly userId: UserId;
  readonly workspaceId?: WorkspaceId;
}

export interface UnitOfWork<Repos> {
  run<T>(context: TenantContext, work: (repos: Repos) => Promise<T>): Promise<T>;
}
