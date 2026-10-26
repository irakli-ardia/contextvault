import {
  AlreadyMember,
  isRole,
  type Membership,
  parseUserId,
  parseWorkspaceId,
  type Role,
  UnknownUser,
  type UserId,
  type Workspace,
  WorkspaceAccessDenied,
  type WorkspaceId,
  type WorkspaceRepository,
} from "@contextvault/domain";
import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "../../client";
import { memberships, workspaces } from "../../schema/index";
import { postgresErrorCode } from "./postgres-error";

const uniqueViolation = "23505";
const foreignKeyViolation = "23503";
const insufficientPrivilege = "42501";
// ponytail: fixed cap instead of a cursor; add one when a user can belong to more workspaces.
const listLimit = 100;

function toWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return { id: parseWorkspaceId(row.id), name: row.name, createdAt: row.createdAt };
}

function toMembership(row: typeof memberships.$inferSelect): Membership {
  if (!isRole(row.role)) throw new Error("Unexpected membership role in database");
  return {
    workspaceId: parseWorkspaceId(row.workspaceId),
    userId: parseUserId(row.userId),
    role: row.role,
  };
}

function translate(error: unknown): unknown {
  switch (postgresErrorCode(error)) {
    case uniqueViolation:
      return new AlreadyMember({ cause: error });
    case foreignKeyViolation:
      return new UnknownUser({ cause: error });
    case insufficientPrivilege:
      return new WorkspaceAccessDenied({ cause: error });
    default:
      return error;
  }
}

export function createWorkspaceRepository(executor: Executor): WorkspaceRepository {
  async function addMember(
    workspaceId: WorkspaceId,
    userId: UserId,
    role: Role,
  ): Promise<Membership> {
    // No RETURNING: the select policy only shows a user their own rows, so returning the row of
    // another member would fail the insert.
    try {
      await executor.insert(memberships).values({ workspaceId, userId, role });
    } catch (error) {
      throw translate(error);
    }
    return { workspaceId, userId, role };
  }

  return {
    async insert(workspace, ownerUserId) {
      const [row] = await executor
        .insert(workspaces)
        .values({ id: workspace.id, name: workspace.name, createdBy: ownerUserId })
        .returning()
        .catch((error: unknown) => {
          if (postgresErrorCode(error) === insufficientPrivilege) {
            throw new WorkspaceAccessDenied({ cause: error });
          }
          throw error;
        });
      if (row === undefined) throw new Error("Workspace insert returned no row");
      await addMember(workspace.id, ownerUserId, "owner");
      return toWorkspace(row);
    },

    async findById(id) {
      const [row] = await executor.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
      return row === undefined ? null : toWorkspace(row);
    },

    async findMembership(workspaceId, userId) {
      const [row] = await executor
        .select()
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
        .limit(1);
      return row === undefined ? null : toMembership(row);
    },

    async listForUser(userId) {
      const rows = await executor
        .select({ workspace: workspaces, role: memberships.role })
        .from(workspaces)
        .innerJoin(memberships, eq(memberships.workspaceId, workspaces.id))
        .where(eq(memberships.userId, userId))
        .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
        .limit(listLimit);
      return rows.map((row) => {
        if (!isRole(row.role)) throw new Error("Unexpected membership role in database");
        return { ...toWorkspace(row.workspace), role: row.role };
      });
    },

    addMember,
  };
}
