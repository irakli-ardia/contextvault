import type { DeadlineSignal } from "../documents/ports";
import { DomainError } from "../kernel/errors";
import type { UnitOfWork } from "../kernel/unit-of-work";
import type { Embedder } from "../retrieval/embedder";
import {
  maxSearchLimit,
  type SearchHit,
  type SearchRepository,
  searchChunks,
} from "../retrieval/search-chunks";
import type { Actor } from "../workspaces/permissions";

/** Vector signal only: below this cosine similarity a vector hit is noise. Never applied to RRF scores. */
export const minEvidenceSimilarity = 0.05;
const retrievedPassages = 5;
const maxPassageChars = 2_000;
const maxAnswerChars = 2_000;

/** A retrieved chunk as the generator sees it: a 1-based number and text, nothing else. */
export interface Passage {
  readonly number: number;
  readonly content: string;
}

/** What a generator proposes. Untrusted: `answerQuestion` validates it before it is used. */
export interface AnswerDraft {
  readonly answerable: boolean;
  readonly text: string;
  /** Passage numbers the text relies on. */
  readonly citations: readonly number[];
}

/** Grounded answer generation. Provider SDKs and HTTP live behind it (packages/ai). */
export interface Answerer {
  readonly model: string;
  answer(
    input: { readonly question: string; readonly passages: readonly Passage[] },
    signal?: DeadlineSignal,
  ): Promise<AnswerDraft>;
}

/** A classified generation failure; the message is the code, so no document text can leak. */
export class AnswerFailure extends DomainError {
  constructor(
    code: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(code, code, options);
  }
}

export interface Citation {
  /** The server-issued chunk id; it resolved to an authorized span in this request. */
  readonly chunkId: string;
  readonly documentId: string;
  readonly displayName: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly excerpt: string;
}

export type AbstainReason = "no_evidence" | "not_supported";

export type Answer =
  | { readonly kind: "answer"; readonly text: string; readonly citations: readonly Citation[] }
  | { readonly kind: "insufficient_evidence"; readonly reason: AbstainReason };

export interface AnswerQuestionDeps {
  readonly uow: UnitOfWork<{ search: SearchRepository }>;
  readonly embedder: Embedder;
  readonly answerer: Answerer;
}

const abstain = (reason: AbstainReason): Answer => ({ kind: "insufficient_evidence", reason });

/**
 * Retrieval (authorized in SQL) -> generation -> validation. The answer is only kept when it cites
 * at least one retrieved passage; every citation is mapped back from a passage number to a chunk
 * the caller was already allowed to read, so the model can never mint a source.
 */
export async function answerQuestion(
  deps: AnswerQuestionDeps,
  actor: Actor,
  input: { readonly question: string },
): Promise<Answer> {
  // RRF decides order only. Evidence is judged on raw signals: a vector hit at or above the
  // threshold, or any keyword match (all query terms present). The pool is filtered before it is
  // cut to `retrievedPassages`, so fused-high but unsupported hits cannot crowd out evidence.
  const pool = await searchChunks(deps, actor, {
    query: input.question,
    limit: maxSearchLimit,
    mode: "hybrid",
  });
  const hits: readonly SearchHit[] = pool
    .filter(
      (hit) => (hit.scores.vector ?? -1) >= minEvidenceSimilarity || hit.scores.keyword !== null,
    )
    .slice(0, retrievedPassages);
  if (hits.length === 0) return abstain("no_evidence");

  const passages = hits.map((hit, i) => ({
    number: i + 1,
    content: hit.content.slice(0, maxPassageChars),
  }));
  const draft = await deps.answerer.answer({ question: input.question.trim(), passages });

  const cited = [...new Set(draft.citations)]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= hits.length)
    .sort((a, b) => a - b);
  const text = draft.text.trim();
  if (!draft.answerable || text === "" || cited.length === 0) return abstain("not_supported");

  return {
    kind: "answer",
    text: text.slice(0, maxAnswerChars),
    citations: cited.flatMap((n) => {
      const hit = hits[n - 1];
      return hit === undefined
        ? []
        : [
            {
              chunkId: hit.chunkId,
              documentId: hit.documentId,
              displayName: hit.displayName,
              startOffset: hit.startOffset,
              endOffset: hit.endOffset,
              excerpt: hit.content,
            },
          ];
    }),
  };
}
