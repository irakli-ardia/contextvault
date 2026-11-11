import type { Persistence } from "@contextvault/db";
import { type Actor, deleteDocument, getDocument, listDocuments } from "@contextvault/domain";
import { Controller, Delete, Get, HttpCode, Inject, Param } from "@nestjs/common";
import { CurrentActor } from "../../auth/request-state";
import { PERSISTENCE } from "../../auth/tokens";
import { toDocumentResponse } from "./document-response";

// Transport only. Guards (Origin, session, membership) have run; the role check is in the use case.
@Controller("workspaces/:workspaceId/documents")
export class DocumentsController {
  private readonly uow: Persistence["unitOfWork"];

  constructor(@Inject(PERSISTENCE) persistence: Persistence) {
    this.uow = persistence.unitOfWork;
  }

  @Get()
  async list(@CurrentActor() actor: Actor) {
    const documents = await listDocuments({ uow: this.uow }, actor);
    return { documents: documents.map(toDocumentResponse) };
  }

  @Get(":documentId")
  async read(@CurrentActor() actor: Actor, @Param("documentId") documentId: string) {
    return toDocumentResponse(await getDocument({ uow: this.uow }, actor, documentId));
  }

  // Idempotent: a repeated delete answers 204 like the first.
  @Delete(":documentId")
  @HttpCode(204)
  async remove(@CurrentActor() actor: Actor, @Param("documentId") documentId: string) {
    await deleteDocument({ uow: this.uow }, { actor, documentId });
  }
}
