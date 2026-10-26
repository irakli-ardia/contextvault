import type { UserId } from "../kernel/ids";
import type { UnitOfWork } from "../kernel/unit-of-work";
import type { WorkspaceRepository } from "../workspaces/ports";
import type { WorkspaceWithRole } from "../workspaces/workspace";
import { Unauthenticated } from "./errors";
import type { User, UserRepository } from "./ports";

export interface Profile {
  readonly user: User;
  readonly workspaces: readonly WorkspaceWithRole[];
}

export async function getProfile(
  uow: UnitOfWork<{ users: UserRepository; workspaces: WorkspaceRepository }>,
  userId: UserId,
): Promise<Profile> {
  return uow.run({ userId }, async ({ users, workspaces }) => {
    const user = await users.findById(userId);
    // A session row cannot outlive its user (foreign key), but a user the policies hide is the
    // same to this caller: treat it as signed out rather than inventing a profile.
    if (user === null) throw new Unauthenticated();
    return { user, workspaces: await workspaces.listForUser(userId) };
  });
}
