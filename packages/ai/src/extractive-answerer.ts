import type { Answerer } from "@contextvault/domain/answers";

// Offline, free, deterministic and NOT a language model: it quotes the passage sentence that shares
// the most words with the question, and abstains unless at least half of the question's content
// words occur in one passage. It powers tests and the zero-cost demo; changing the rule changes
// `model`.
const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];

export const extractiveAnswerer: Answerer = {
  model: "extractive-v1",
  answer({ question, passages }) {
    const wanted = new Set(words(question));
    let best = { score: 0, number: 0, sentence: "" };
    for (const passage of passages) {
      for (const sentence of passage.content.split(/(?<=[.!?])\s+|\n+/)) {
        const have = new Set(words(sentence));
        const score = [...wanted].filter((w) => have.has(w)).length;
        if (score > best.score) best = { score, number: passage.number, sentence: sentence.trim() };
      }
    }
    const supported = wanted.size > 0 && best.score >= Math.ceil(wanted.size / 2);
    return Promise.resolve(
      supported
        ? { answerable: true, text: best.sentence, citations: [best.number] }
        : { answerable: false, text: "", citations: [] },
    );
  },
};
