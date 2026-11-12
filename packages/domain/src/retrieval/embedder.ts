import type { DeadlineSignal } from "../documents/ports";
import { DomainError } from "../kernel/errors";

/** The `chunk_embeddings.embedding` column is `vector(1536)`; every embedder must match it. */
export const embeddingDimensions = 1536;

/** A classified embedding failure; the message is the code, so no document text can leak. */
export class EmbeddingFailure extends DomainError {
  constructor(
    code: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(code, code, options);
  }
}

/** Turns texts into vectors. Provider SDKs and HTTP live behind it (packages/ai). */
export interface Embedder {
  /** Stored with every vector; a query is only compared with vectors of the same model. */
  readonly model: string;
  /** One `embeddingDimensions`-long vector per text, same order. Throws `EmbeddingFailure`. */
  embed(texts: readonly string[], signal?: DeadlineSignal): Promise<readonly (readonly number[])[]>;
}
