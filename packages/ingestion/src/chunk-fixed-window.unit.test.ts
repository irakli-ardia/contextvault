import { describe, expect, it } from "vitest";
import { chunkFixedWindow, chunkStrategy } from "./chunk-fixed-window";
import type { ParsedDocument } from "./parsed-document";

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const text = (value: string): ParsedDocument => ({ format: "text", text: value });
const words = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`).join(" ");
const { windowUnits, overlapUnits } = chunkStrategy;

describe("chunkFixedWindow", () => {
  it("round-trips: every chunk is the text between its offsets", () => {
    const body = words(3000);
    const { chunks } = chunkFixedWindow(text(body), ids());
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.content).toBe(body.slice(chunk.startOffset, chunk.endOffset));
    }
  });

  it("is bounded, ordered, overlapping, covers the whole text, and never repeats a span", () => {
    const body = words(3000);
    const { chunks } = chunkFixedWindow(text(body), ids());
    chunks.forEach((chunk, i) => {
      expect(chunk.ordinal).toBe(i);
      expect(chunk.endOffset - chunk.startOffset).toBeLessThanOrEqual(windowUnits);
      const previous = chunks[i - 1];
      if (previous === undefined) return;
      expect(chunk.endOffset).toBeGreaterThan(previous.endOffset);
      expect(chunk.startOffset).toBeGreaterThan(previous.startOffset);
      expect(previous.endOffset - chunk.startOffset).toBeLessThanOrEqual(overlapUnits);
      expect(previous.endOffset).toBeGreaterThanOrEqual(chunk.startOffset);
    });
    expect(chunks[0]?.startOffset).toBe(0);
    expect(chunks.at(-1)?.endOffset).toBe(body.length);
  });

  it("is deterministic for the same text whatever the ids are", () => {
    const body = words(2500);
    const strip = (set: ReturnType<typeof chunkFixedWindow>) =>
      set.chunks.map(({ id: _id, sectionId: _s, ...rest }) => rest);
    expect(strip(chunkFixedWindow(text(body), ids()))).toEqual(
      strip(chunkFixedWindow(text(body), () => crypto.randomUUID())),
    );
  });

  it("keeps a short text in one chunk and one section", () => {
    const set = chunkFixedWindow(text("hello"), ids());
    expect(set.chunks).toHaveLength(1);
    expect(set.sections).toEqual([
      { id: set.chunks[0]?.sectionId, ordinal: 0, page: null, startOffset: 0, endOffset: 5 },
    ]);
    expect(set.chunks[0]).toMatchObject({
      content: "hello",
      tokenCount: 2,
      startOffset: 0,
      endOffset: 5,
    });
  });

  it("produces no chunk and no section for whitespace only", () => {
    expect(chunkFixedWindow(text(" \n\t "), ids())).toMatchObject({ chunks: [], sections: [] });
  });

  it("splits an oversized unbroken run at the window", () => {
    const { chunks } = chunkFixedWindow(text("x".repeat(windowUnits * 2)), ids());
    expect(chunks.map((c) => c.endOffset - c.startOffset)).toEqual([windowUnits, windowUnits, 400]);
  });

  it("prefers a whitespace boundary near the window end", () => {
    const body = `${"a".repeat(windowUnits - 100)} ${"b".repeat(windowUnits)}`;
    expect(chunkFixedWindow(text(body), ids()).chunks[0]?.endOffset).toBe(windowUnits - 99);
  });

  it("never cuts a surrogate pair, and offsets round-trip on Georgian and astral text", () => {
    const body = `${"ქართული ტექსტი ".repeat(300)}${"😀".repeat(3000)}`;
    const { chunks } = chunkFixedWindow(text(body), ids());
    for (const chunk of chunks) {
      expect(chunk.content).toBe(body.slice(chunk.startOffset, chunk.endOffset));
      expect(chunk.content.isWellFormed()).toBe(true);
    }
    expect(chunks.at(-1)?.endOffset).toBe(body.length);
  });

  it("hashes the UTF-8 content and estimates tokens at one per four code points", () => {
    const [chunk] = chunkFixedWindow(text("😀😀😀😀😀"), ids()).chunks;
    expect(chunk?.tokenCount).toBe(2);
    expect(chunk?.contentSha256).toHaveLength(32);
  });

  it("makes one section per non-blank PDF page and never crosses a page", () => {
    const pages = ["first page text", "   ", "third page text"];
    let body = "";
    const spans = pages.map((page, i) => {
      const start = i === 0 ? 0 : body.length + 1;
      body = i === 0 ? page : `${body}\n${page}`;
      return { page: i + 1, start, end: start + page.length };
    });
    const set = chunkFixedWindow({ format: "pdf", text: body, pages: spans }, ids());
    expect(set.sections.map((s) => [s.ordinal, s.page])).toEqual([
      [0, 1],
      [1, 3],
    ]);
    expect(set.chunks.map((c) => [c.sectionId, c.content])).toEqual([
      [set.sections[0]?.id, "first page text"],
      [set.sections[1]?.id, "third page text"],
    ]);
  });

  it("chunks the largest supported text (2,000,000 units) into more than 1,000 chunks with no gap", () => {
    const body = "lorem ipsum dolor sit amet ".repeat(80_000).slice(0, 2_000_000);
    const { chunks } = chunkFixedWindow(text(body), ids());
    expect(chunks.length).toBeGreaterThan(1_000);
    expect(chunks[0]?.startOffset).toBe(0);
    expect(chunks.at(-1)?.endOffset).toBe(body.length);
    chunks.forEach((c, i) => {
      if (i > 0) expect(c.startOffset).toBeLessThanOrEqual(chunks[i - 1]?.endOffset ?? 0);
    });
  });
});
