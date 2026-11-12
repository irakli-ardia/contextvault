import type { Persistence } from "@contextvault/db";
import type { Actor, Embedder } from "@contextvault/domain";
import { type Answerer, answerQuestion } from "@contextvault/domain/answers";
import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { CurrentActor } from "../../auth/request-state";
import { PERSISTENCE } from "../../auth/tokens";
import { ApiError } from "../../http/api-error";
import type { RetryLimiter } from "../retry-limiter";
import { ANSWER_LIMITER, ANSWERER, EMBEDDER } from "../tokens";

// Strict: unknown keys (a smuggled `workspaceId`) are a 400; the workspace comes from the route.
const answerBody = z.strictObject({ question: z.string().max(1_000) });

// Transport only. Stateless: nothing is stored, so there is no history to leak or purge.
@Controller("workspaces/:workspaceId/answers")
export class AnswersController {
  private readonly uow: Persistence["unitOfWork"];

  constructor(
    @Inject(PERSISTENCE) persistence: Persistence,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    @Inject(ANSWERER) private readonly answerer: Answerer,
    @Inject(ANSWER_LIMITER) private readonly limiter: RetryLimiter,
  ) {
    this.uow = persistence.unitOfWork;
  }

  @Post()
  @HttpCode(200)
  async answer(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const parsed = answerBody.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "request.invalid");
    this.limiter.take(actor.userId);
    const deps = { uow: this.uow, embedder: this.embedder, answerer: this.answerer };
    const result = await answerQuestion(deps, actor, parsed.data);
    return { model: this.answerer.model, ...result };
  }
}
