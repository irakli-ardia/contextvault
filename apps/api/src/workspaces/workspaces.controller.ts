import type { Persistence } from "@contextvault/db";
import { type Actor, readWorkspace } from "@contextvault/domain";
import { Controller, Get, Inject } from "@nestjs/common";
import { CurrentActor } from "../auth/request-state";
import { PERSISTENCE } from "../auth/tokens";

// Exercises the guard chain end to end; later increments hang their routes under this prefix.
@Controller("workspaces/:workspaceId")
export class WorkspacesController {
  private readonly uow: Persistence["unitOfWork"];

  constructor(@Inject(PERSISTENCE) persistence: Persistence) {
    this.uow = persistence.unitOfWork;
  }

  @Get()
  async read(@CurrentActor() actor: Actor): Promise<{ id: string; name: string; role: string }> {
    const { id, name, role } = await readWorkspace(this.uow, actor);
    return { id, name, role };
  }
}
