import type { UserId, WorkspaceId } from "../kernel/ids";
import type { UnitOfWork } from "../kernel/unit-of-work";
import { WorkspaceAccessDenied } from "./errors";
import type { Actor } from "./permissions";
import type { WorkspaceRepository } from "./ports";

/** A non-member and a missing workspace are indistinguishable: both are access denied. */
export async function resolveActor(
  uow: UnitOfWork<{ workspaces: WorkspaceRepository }>,
  userId: UserId,
  workspaceId: WorkspaceId,
): Promise<Actor> {
  const membership = await uow.run({ userId }, (repos) =>
    repos.workspaces.findMembership(workspaceId, userId),
  );
  if (membership === null) throw new WorkspaceAccessDenied();
  return { userId, workspaceId, role: membership.role };
}
