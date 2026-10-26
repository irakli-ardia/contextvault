import type { UserId, WorkspaceId } from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Database } from "../client";
import { establishContext } from "../context";
import { createRepositories } from "../repositories/index";

export const workspaceLockName = (userId: UserId): string => `initial-workspace:${userId}`;

export type EnsureWorkspace = (
  userId: UserId,
  workspace: { id: WorkspaceId; name: string },
) => Promise<{ name: string; created: boolean }>;

// Application role, under the user's own context, so RLS is fully in force. A transaction-level
// advisory lock keyed by the user (any role may take it; it vanishes at commit or rollback) makes
// concurrent runs for the same email take turns: the second one waits, then sees the first one's
// workspace and creates nothing. Returns the workspace that actually exists.
export function createEnsureWorkspace(db: Database): EnsureWorkspace {
  return (userId, workspace) =>
    db.transaction(async (tx) => {
      await establishContext(tx, { userId });
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${workspaceLockName(userId)}, 0))`,
      );
      const repos = createRepositories(tx);
      const [existing] = await repos.workspaces.listForUser(userId);
      if (existing !== undefined) return { name: existing.name, created: false };
      await repos.workspaces.insert(workspace, userId);
      return { name: workspace.name, created: true };
    });
}
