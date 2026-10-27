import type { DocumentMime } from "./document";
import { UploadRejected } from "./errors";

/** Bytes are fed in order; any violation throws at once. `finish` gives the verdict for the end. */
export interface ContentVerifier {
  update(chunk: Uint8Array): void;
  finish(): void;
}

const mismatch = () => new UploadRejected("upload.content_mismatch");
const pdfSignature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

function pdfVerifier(): ContentVerifier {
  let seen = 0;
  return {
    update(chunk) {
      for (const byte of chunk) {
        if (seen >= pdfSignature.length) return;
        if (byte !== pdfSignature[seen]) throw mismatch();
        seen += 1;
      }
    },
    finish() {
      if (seen < pdfSignature.length) throw mismatch();
    },
  };
}

interface Sequence {
  missing: number; // continuation bytes still expected
  low: number; // allowed range of the first of them
  high: number;
}

// Lead byte of a multi-byte sequence (RFC 3629: no overlongs, surrogates, or over U+10FFFF).
function lead(byte: number): Sequence {
  if (byte >= 0xf5 || (byte >= 0x80 && byte < 0xc2)) throw mismatch();
  let missing = 3;
  if (byte < 0xe0) missing = 1;
  else if (byte < 0xf0) missing = 2;
  const limits: Record<number, [number, number]> = {
    224: [0xa0, 0xbf],
    237: [0x80, 0x9f],
    240: [0x90, 0xbf],
    244: [0x80, 0x8f],
  };
  const [low, high] = limits[byte] ?? [0x80, 0xbf];
  return { missing, low, high };
}

// Checked byte by byte so a sequence split across chunks needs no buffer. NUL is refused too.
function textVerifier(): ContentVerifier {
  let seq: Sequence | undefined;
  const step = (byte: number): void => {
    if (seq !== undefined) {
      if (byte < seq.low || byte > seq.high) throw mismatch();
      seq = seq.missing === 1 ? undefined : { missing: seq.missing - 1, low: 0x80, high: 0xbf };
    } else if (byte === 0) {
      throw mismatch();
    } else if (byte >= 0x80) {
      seq = lead(byte);
    }
  };
  return {
    update(chunk) {
      for (const byte of chunk) step(byte);
    },
    finish() {
      if (seq !== undefined) throw mismatch();
    },
  };
}

export const createContentVerifier = (mime: DocumentMime): ContentVerifier =>
  mime === "application/pdf" ? pdfVerifier() : textVerifier();
