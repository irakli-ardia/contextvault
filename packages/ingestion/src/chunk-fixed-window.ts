import { createHash } from "node:crypto";
import type { ChunkSet, NewChunk, NewSection } from "@contextvault/domain";
import type { ParsedDocument } from "./parsed-document";

/**
 * Baseline strategy (M1.6): a fixed window over the parsed text, measured in UTF-16 units so
 * offsets are the ones `ParsedDocument` already uses. The token count is an estimate (one token
 * per four code points); real tokenizers and strategies are compared in M2.
 * Changing any value below changes chunk identity, so it must bump `chunkStrategy.version`.
 */
export const chunkStrategy = {
  id: "fixed-window",
  version: 1,
  windowUnits: 2000,
  overlapUnits: 200,
  /** A window ends at the last whitespace within this many units of its limit, if there is one. */
  breakLookbackUnits: 400,
} as const;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Moves a cut left until it falls between two code points. */
function cutOutsideSurrogatePair(text: string, cut: number): number {
  return isLowSurrogate(text.charCodeAt(cut)) && isHighSurrogate(text.charCodeAt(cut - 1))
    ? cut - 1
    : cut;
}

function windowEnd(text: string, start: number, limit: number): number {
  const hard = start + chunkStrategy.windowUnits;
  if (hard >= limit) return limit;
  const floor = hard - chunkStrategy.breakLookbackUnits;
  for (let i = hard; i > floor; i -= 1) {
    if (/\s/.test(text.charAt(i - 1))) return i;
  }
  return cutOutsideSurrogatePair(text, hard);
}

function estimateTokens(content: string): number {
  let codePoints = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (!isLowSurrogate(content.charCodeAt(i))) codePoints += 1;
  }
  return Math.max(1, Math.ceil(codePoints / 4));
}

/** `[start, end)` ranges of the document that chunks never cross: PDF pages, or the whole text. */
function sectionRanges(
  document: ParsedDocument,
): { page: number | null; start: number; end: number }[] {
  return document.format === "pdf"
    ? document.pages.map(({ page, start, end }) => ({ page, start, end }))
    : [{ page: null, start: 0, end: document.text.length }];
}

/**
 * Pure and deterministic: the same text yields the same spans, in order, whatever `newId` returns.
 * Every chunk is exactly `text.slice(start, end)` (so offsets round-trip), is never empty or
 * whitespace-only, and lies inside one section. Consecutive chunks of a section overlap by
 * `overlapUnits`, and each reaches past the previous one's end, so none is a duplicate span.
 * A section with no visible text (a blank page) gets no section row. The result may hold no
 * chunks at all; the caller decides what that means.
 */
export function chunkFixedWindow(document: ParsedDocument, newId: () => string): ChunkSet {
  const { text } = document;
  const sections: NewSection[] = [];
  const chunks: NewChunk[] = [];
  for (const range of sectionRanges(document)) {
    const sectionId = newId();
    const firstChunk = chunks.length;
    let start = range.start;
    while (start < range.end) {
      const end = windowEnd(text, start, range.end);
      const content = text.slice(start, end);
      if (content.trim() !== "") {
        chunks.push({
          id: newId(),
          sectionId,
          ordinal: chunks.length,
          content,
          contentSha256: createHash("sha256").update(content, "utf8").digest(),
          tokenCount: estimateTokens(content),
          startOffset: start,
          endOffset: end,
        });
      }
      if (end >= range.end) break;
      // The window is far larger than the overlap, so this always moves forward.
      start = cutOutsideSurrogatePair(text, end - chunkStrategy.overlapUnits);
    }
    if (chunks.length > firstChunk) {
      sections.push({
        id: sectionId,
        ordinal: sections.length,
        page: range.page,
        startOffset: range.start,
        endOffset: range.end,
      });
    }
  }
  return { strategyId: chunkStrategy.id, strategyVersion: chunkStrategy.version, sections, chunks };
}
