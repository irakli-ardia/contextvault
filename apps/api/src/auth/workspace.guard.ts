import type { Persistence } from "@contextvault/db";
import {
  parseWorkspaceId,
  resolveActor,
  type UnitOfWork,
  WorkspaceAccessDenied,
  type WorkspaceRepository,
} from "@contextvault/domain";
import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { HttpRequest } from "./http-types";
import { bindActor, identityOf } from "./request-state";
import { PERSISTENCE } from "./tokens";

// Active on routes with a :workspaceId segment. A malformed id, a missing workspace, and a
// workspace of which the user is not a member all give the same refusal.
@Injectable()
export class WorkspaceGuard implements CanActivate {
  private readonly uow: UnitOfWork<{ workspaces: WorkspaceRepository }>;

  constructor(@Inject(PERSISTENCE) persistence: Persistence) {
    this.uow = persistence.unitOfWork;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const raw = req.params.workspaceId;
    if (raw === undefined) return true;
    const identity = identityOf(req);
    // Public routes never carry a workspace segment; refuse rather than guess.
    if (identity === undefined) throw new WorkspaceAccessDenied();
    let workspaceId: ReturnType<typeof parseWorkspaceId>;
    try {
      workspaceId = parseWorkspaceId(raw);
    } catch {
      throw new WorkspaceAccessDenied();
    }
    bindActor(req, await resolveActor(this.uow, identity.userId, workspaceId));
    return true;
  }
}
