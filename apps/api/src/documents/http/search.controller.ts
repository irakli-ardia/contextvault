import { SEARCH_MODES, type SearchResponse } from "@contextvault/contracts";
import type { Persistence } from "@contextvault/db";
import { type Actor, type Embedder, searchChunks } from "@contextvault/domain";
import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { CurrentActor } from "../../auth/request-state";
import { PERSISTENCE } from "../../auth/tokens";
import { ApiError } from "../../http/api-error";
import { EMBEDDER } from "../tokens";

// Strict: unknown keys (a smuggled `workspaceId`) are a 400. The workspace comes from the route and
// is checked by the workspace guard against the session; `limit` is bounded by the use case.
const searchBody = z.strictObject({
  query: z.string().max(10_000),
  limit: z.number().int().optional(),
  mode: z.enum(SEARCH_MODES).optional(),
});

// Transport only. The query travels in the body so it never lands in URLs or access logs.
@Controller("workspaces/:workspaceId/search")
export class SearchController {
  private readonly uow: Persistence["unitOfWork"];

  constructor(
    @Inject(PERSISTENCE) persistence: Persistence,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
  ) {
    this.uow = persistence.unitOfWork;
  }

  @Post()
  @HttpCode(200)
  async search(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<SearchResponse> {
    const parsed = searchBody.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "request.invalid");
    const hits = await searchChunks({ uow: this.uow, embedder: this.embedder }, actor, parsed.data);
    return {
      model: this.embedder.model,
      mode: parsed.data.mode ?? "vector",
      results: hits.map((hit) => ({
        chunkId: hit.chunkId,
        documentId: hit.documentId,
        displayName: hit.displayName,
        content: hit.content,
        startOffset: hit.startOffset,
        endOffset: hit.endOffset,
        // Kept for existing consumers; it is the vector score.
        similarity: hit.scores.vector,
        scores: hit.scores,
        ranks: hit.ranks,
      })),
    };
  }
}
