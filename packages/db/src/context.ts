import type { TenantContext, WorkerContext } from "@contextvault/domain";
import { WorkspaceAccessDenied } from "@contextvault/domain";
import { eq, sql } from "drizzle-orm";
import type { Executor } from "./client";
import { memberships } from "./schema/index";

// Settings are transaction-local (is_local = true): they vanish at commit or rollback, so a pooled
// connection never carries one borrower's identity to the next. Policies treat the user id as the
// asserted identity and require a membership row for it; the workspace id only narrows.
export async function establishContext(tx: Executor, context: TenantContext): Promise<void> {
  await tx.execute(
    sql`select set_config('app.user_id', ${context.userId}, true),
      set_config('app.workspace_id', ${context.workspaceId ?? ""}, true)`,
  );
  if (context.workspaceId === undefined) return;
  // Policy-filtered to the user's own rows: a workspace the user does not belong to (or that
  // does not exist) yields nothing, so the claim is refused before any work runs.
  const [proof] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(eq(memberships.workspaceId, context.workspaceId))
    .limit(1);
  if (proof === undefined) throw new WorkspaceAccessDenied();
}

// The worker acts for no user and holds no membership grant, so there is nothing to prove: the
// asserted workspace is the only setting, and the worker policies bind every write to it.
export async function establishWorkerContext(tx: Executor, context: WorkerContext): Promise<void> {
  await tx.execute(sql`select set_config('app.workspace_id', ${context.workspaceId}, true)`);
}
