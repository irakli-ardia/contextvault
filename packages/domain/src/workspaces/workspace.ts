import type { UserId, WorkspaceId } from "../kernel/ids";

export const roles = ["owner", "admin", "member"] as const;
export type Role = (typeof roles)[number];

export const isRole = (value: string): value is Role => roles.some((role) => role === value);

export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly createdAt: Date;
}

export type WorkspaceWithRole = Workspace & { readonly role: Role };

export interface Membership {
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly role: Role;
}
