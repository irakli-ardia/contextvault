import type { UnitOfWork } from "../kernel/unit-of-work";
import { WorkspaceAccessDenied } from "./errors";
import { type Actor, assertCan } from "./permissions";
import type { WorkspaceRepository } from "./ports";
import type { Role, Workspace } from "./workspace";

export async function readWorkspace(
  uow: UnitOfWork<{ workspaces: WorkspaceRepository }>,
  actor: Actor,
): Promise<Workspace & { readonly role: Role }> {
  return uow.run({ userId: actor.userId, workspaceId: actor.workspaceId }, async (repos) => {
    // Role is re-read inside the transaction: the actor's is a per-request snapshot.
    const membership = await repos.workspaces.findMembership(actor.workspaceId, actor.userId);
    const workspace = await repos.workspaces.findById(actor.workspaceId);
    if (membership === null || workspace === null) throw new WorkspaceAccessDenied();
    assertCan({ ...actor, role: membership.role }, "workspace.read", workspace.id);
    return { ...workspace, role: membership.role };
  });
}
