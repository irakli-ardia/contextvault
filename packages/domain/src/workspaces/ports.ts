import type { UserId, WorkspaceId } from "../kernel/ids";
import type { Membership, Role, Workspace, WorkspaceWithRole } from "./workspace";

export interface WorkspaceRepository {
  /** Creates the workspace and its owner membership; the owner must be the acting user. */
  insert(workspace: { id: WorkspaceId; name: string }, ownerUserId: UserId): Promise<Workspace>;
  findById(id: WorkspaceId): Promise<Workspace | null>;
  findMembership(workspaceId: WorkspaceId, userId: UserId): Promise<Membership | null>;
  /** The user's own workspaces with their role in each. */
  listForUser(userId: UserId): Promise<readonly WorkspaceWithRole[]>;
  addMember(workspaceId: WorkspaceId, userId: UserId, role: Role): Promise<Membership>;
}
