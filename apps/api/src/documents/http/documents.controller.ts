import type { Persistence } from "@contextvault/db";
import { type Actor, deleteDocument } from "@contextvault/domain";
import { Controller, Delete, HttpCode, Inject, Param } from "@nestjs/common";
import { CurrentActor } from "../../auth/request-state";
import { PERSISTENCE } from "../../auth/tokens";

// Transport only. Guards (Origin, session, membership) have run; the role check is in the use case.
@Controller("workspaces/:workspaceId/documents")
export class DocumentsController {
  private readonly uow: Persistence["unitOfWork"];

  constructor(@Inject(PERSISTENCE) persistence: Persistence) {
    this.uow = persistence.unitOfWork;
  }

  // Idempotent: a repeated delete answers 204 like the first.
  @Delete(":documentId")
  @HttpCode(204)
  async remove(@CurrentActor() actor: Actor, @Param("documentId") documentId: string) {
    await deleteDocument({ uow: this.uow }, { actor, documentId });
  }
}
