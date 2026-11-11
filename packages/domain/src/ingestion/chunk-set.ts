/** A contiguous, ordered part of the document text that chunks never cross: a PDF page, or all text. */
export interface NewSection {
  readonly id: string;
  readonly ordinal: number;
  /** 1-based PDF page; `null` for text. */
  readonly page: number | null;
  /** `[startOffset, endOffset)` are UTF-16 offsets into the parsed text. */
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface NewChunk {
  readonly id: string;
  readonly sectionId: string;
  /** Position in the version, from 0, across all sections. */
  readonly ordinal: number;
  /** Exactly the parsed text between the offsets. */
  readonly content: string;
  /** SHA-256 of the UTF-8 content. */
  readonly contentSha256: Uint8Array;
  /** An estimate (see the chunker); a real tokenizer arrives with M2. */
  readonly tokenCount: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

/** What the chunking stage hands to activation: everything a version needs to become searchable. */
export interface ChunkSet {
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly sections: readonly NewSection[];
  readonly chunks: readonly NewChunk[];
}
