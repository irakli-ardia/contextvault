// Deterministic synthetic documents for the ingestion benchmark: plain-text paragraphs of
// Zipf-like tokens (the retrieval corpus' distribution), never real or sensitive content.

import { rng } from "./retrieval-corpus.mjs";

const VOCABULARY = 20_000;
const WORDS_PER_PARAGRAPH = 60;

/** Exactly `chars` ASCII characters, so bytes equal chars and the parser's text limit is hit exactly. */
export function documentText(seed, chars) {
  const rand = rng(5_000_011 + seed);
  const parts = [];
  let length = 0;
  let inParagraph = 0;
  while (length < chars) {
    const word = `t${Math.floor(VOCABULARY * rand() ** 3).toString(36)}`;
    inParagraph += 1;
    const separator = inParagraph === WORDS_PER_PARAGRAPH ? "\n\n" : " ";
    if (inParagraph === WORDS_PER_PARAGRAPH) inParagraph = 0;
    parts.push(word, separator);
    length += word.length + separator.length;
  }
  return parts.join("").slice(0, chars);
}

export const CLASSES = {
  small: 20_000,
  medium: 200_000,
  large: 1_000_000,
  max: 2_000_000, // parseLimits.maxChars: the largest text the parser accepts
};
export const SMOKE_CLASSES = { small: 4_000, medium: 20_000, large: 60_000, max: 100_000 };

/** The 50-document workspace mix: mostly small, a few large, one at the limit. */
export const MIX = { small: 30, medium: 14, large: 5, max: 1 };
