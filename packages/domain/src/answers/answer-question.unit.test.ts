import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "../kernel/ids";
import type { SearchHit, SearchRepository } from "../retrieval/search-chunks";
import { type AnswerDraft, type Answerer, answerQuestion } from "./answer-question";

const actor = {
  userId: parseUserId("00000000-0000-4000-8000-000000000002"),
  workspaceId: parseWorkspaceId("00000000-0000-4000-8000-000000000001"),
  role: "member",
} as const;

const hit = (n: number, similarity: number): SearchHit => ({
  chunkId: `chunk-${n}`,
  documentId: `doc-${n}`,
  displayName: `d${n}.txt`,
  content: `content ${n}`,
  startOffset: 0,
  endOffset: 9,
  scores: { vector: similarity, keyword: null, fused: null },
  ranks: { vector: n, keyword: null },
});

function setup(hits: SearchHit[], draft: AnswerDraft) {
  const seen: Parameters<Answerer["answer"]>[0][] = [];
  const answerer: Answerer = {
    model: "fake",
    answer: async (input) => {
      seen.push(input);
      return draft;
    },
  };
  const deps = {
    answerer,
    embedder: { model: "m", embed: async (t: readonly string[]) => t.map(() => [1]) },
    uow: {
      run: async <T>(_c: unknown, work: (r: { search: SearchRepository }) => Promise<T>) =>
        work({
          search: {
            nearest: async () =>
              hits.map(({ scores, ...chunk }) => ({ ...chunk, score: scores.vector ?? 0 })),
            keyword: async () => [],
          },
        }),
    },
  };
  return { deps, seen };
}

describe("answerQuestion", () => {
  it("abstains without calling the model when nothing relevant was retrieved", async () => {
    const { deps, seen } = setup([hit(1, 0.01)], { answerable: true, text: "x", citations: [1] });
    expect(await answerQuestion(deps, actor, { question: "q" })).toEqual({
      kind: "insufficient_evidence",
      reason: "no_evidence",
    });
    expect(seen).toHaveLength(0);
  });

  it("maps passage numbers back to server-resolved chunks and drops invented ones", async () => {
    const { deps } = setup([hit(1, 0.9), hit(2, 0.5)], {
      answerable: true,
      text: " It is 30 days. ",
      citations: [2, 2, 99, 0, 1.5],
    });
    const result = await answerQuestion(deps, actor, { question: "q" });
    expect(result).toMatchObject({ kind: "answer", text: "It is 30 days." });
    expect(result.kind === "answer" && result.citations.map((c) => c.chunkId)).toEqual(["chunk-2"]);
  });

  it.each([
    ["declined", { answerable: false, text: "", citations: [] }],
    ["uncited", { answerable: true, text: "claim", citations: [] }],
    ["only invented citations", { answerable: true, text: "claim", citations: [7] }],
    ["blank text", { answerable: true, text: "  ", citations: [1] }],
  ])("abstains when the model's draft is %s", async (_name, draft) => {
    const { deps } = setup([hit(1, 0.9)], draft);
    expect(await answerQuestion(deps, actor, { question: "q" })).toEqual({
      kind: "insufficient_evidence",
      reason: "not_supported",
    });
  });

  it("gives the model numbered text only, no ids or names", async () => {
    const { deps, seen } = setup([hit(1, 0.9)], { answerable: false, text: "", citations: [] });
    await answerQuestion(deps, actor, { question: " q " });
    expect(seen[0]).toEqual({ question: "q", passages: [{ number: 1, content: "content 1" }] });
  });
});
