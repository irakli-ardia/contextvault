import type { UserId, WorkspaceId } from "../kernel/ids";
import type { Membership, Role, Workspace } from "./workspace";

export interface WorkspaceRepository {
  /** Creates the workspace and its owner membership; the owner must be the acting user. */
  insert(workspace: { id: WorkspaceId; name: string }, ownerUserId: UserId): Promise<Workspace>;
  findById(id: WorkspaceId): Promise<Workspace | null>;
  findMembership(workspaceId: WorkspaceId, userId: UserId): Promise<Membership | null>;
  listForUser(userId: UserId): Promise<readonly Workspace[]>;
  addMember(workspaceId: WorkspaceId, userId: UserId, role: Role): Promise<Membership>;
}
