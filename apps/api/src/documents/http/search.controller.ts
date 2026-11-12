import { SEARCH_MODES, type SearchResponse } from "@contextvault/contracts";
import type { Persistence } from "@contextvault/db";
import {
  type Actor,
  type Embedder,
  maxQueryLength,
  maxSearchLimit,
  searchChunks,
} from "@contextvault/domain";
import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { CurrentActor } from "../../auth/request-state";
import { PERSISTENCE } from "../../auth/tokens";
import { ApiError } from "../../http/api-error";
import type { RetryLimiter } from "../retry-limiter";
import { EMBEDDER, SEARCH_LIMITER } from "../tokens";

// Strict: unknown keys (a smuggled `workspaceId`) are a 400. The workspace comes from the route and
// is checked by the workspace guard against the session. Query and limit bounds mirror the use
// case (which stays the authority) so every invalid request is a 400 *before* the rate limiter.
const searchBody = z.strictObject({
  query: z.string().trim().min(1).max(maxQueryLength),
  limit: z.number().int().min(1).max(maxSearchLimit).optional(),
  mode: z.enum(SEARCH_MODES).optional(),
});

// Transport only. The query travels in the body so it never lands in URLs or access logs.
@Controller("workspaces/:workspaceId/search")
export class SearchController {
  private readonly uow: Persistence["unitOfWork"];

  constructor(
    @Inject(PERSISTENCE) persistence: Persistence,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    @Inject(SEARCH_LIMITER) private readonly limiter: RetryLimiter,
  ) {
    this.uow = persistence.unitOfWork;
  }

  @Post()
  @HttpCode(200)
  async search(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<SearchResponse> {
    const parsed = searchBody.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "request.invalid");
    // After validation and before any embedding or query: a refused request does no work.
    this.limiter.take(actor.userId);
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
