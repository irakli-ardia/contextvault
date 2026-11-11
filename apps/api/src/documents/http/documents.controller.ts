import { randomUUID } from "node:crypto";
import type { Persistence } from "@contextvault/db";
import {
  type Actor,
  assertCan,
  deleteDocument,
  getDocument,
  listDocuments,
  retryDocument,
} from "@contextvault/domain";
import { Controller, Delete, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { CurrentActor } from "../../auth/request-state";
import { PERSISTENCE } from "../../auth/tokens";
import { RetryLimiter } from "../retry-limiter";
import { toDocumentResponse } from "./document-response";

// Transport only. Guards (Origin, session, membership) have run; the role check is in the use case.
@Controller("workspaces/:workspaceId/documents")
export class DocumentsController {
  private readonly uow: Persistence["unitOfWork"];

  constructor(
    @Inject(PERSISTENCE) persistence: Persistence,
    @Inject(RetryLimiter) private readonly retryLimiter: RetryLimiter,
  ) {
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

  // Not idempotent: a repeat finds the version queued and answers 409. The role check comes before
  // the rate-limit slot so a refused role never spends the allowance; the use case checks again.
  @Post(":documentId/retry")
  @HttpCode(202)
  async retry(@CurrentActor() actor: Actor, @Param("documentId") documentId: string) {
    assertCan(actor, "document.retry");
    this.retryLimiter.take(actor.userId);
    const document = await retryDocument(
      { uow: this.uow, newId: randomUUID },
      { actor, documentId },
    );
    return toDocumentResponse(document);
  }
}
