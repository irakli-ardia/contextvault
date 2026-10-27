import { createContentVerifier } from "./content-verifier";
import type { DocumentMime } from "./document";
import { UploadInterrupted, UploadRejected } from "./errors";
import type { Sha256 } from "./upload-ports";

export interface Verification {
  /** Set once the whole body has passed: exact declared length, content verdict, digest. */
  result?: { readonly sha256: Uint8Array };
}

/**
 * Wraps the client bytes for `DocumentStore.put`. The newest chunk is held back until the next one
 * arrives, and the last is released only after the source ended at exactly `declared` bytes and
 * the content verdict passed. Storage therefore never receives the final declared byte of a body
 * that is short, long, malformed or cancelled, so no object is committed for it. Memory is two
 * chunks; nothing is buffered beyond that.
 */
export async function* verifiedBody(
  source: AsyncIterable<Uint8Array>,
  declared: number,
  mime: DocumentMime,
  sha: Sha256,
  state: Verification,
): AsyncGenerator<Uint8Array> {
  const verifier = createContentVerifier(mime);
  let total = 0;
  let held: Uint8Array | undefined;
  try {
    for await (const chunk of source) {
      if (chunk.length === 0) continue;
      if (total + chunk.length > declared) throw new UploadRejected("upload.incomplete");
      total += chunk.length;
      verifier.update(chunk);
      sha.update(chunk);
      const release = held;
      held = chunk;
      if (release !== undefined) yield release;
    }
    if (total !== declared || held === undefined) throw new UploadRejected("upload.incomplete");
    verifier.finish();
  } catch (error) {
    if (error instanceof UploadRejected) throw error;
    // Distinct internal classes; the HTTP layer decides what a client may see.
    const code = error instanceof UploadInterrupted ? error.code : "upload.incomplete";
    throw new UploadRejected(code, "none", { cause: error });
  }
  state.result = { sha256: sha.digest() };
  yield held;
}
