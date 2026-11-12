import { DomainError } from "../kernel/errors";
import type { UnitOfWork } from "../kernel/unit-of-work";
import { type Actor, assertCan } from "../workspaces/permissions";
import type { Embedder } from "./embedder";

const maxQueryLength = 1_000;
const defaultSearchLimit = 5;
const maxSearchLimit = 20;

export interface SearchHit {
  readonly chunkId: string;
  readonly documentId: string;
  readonly displayName: string;
  readonly content: string;
  readonly startOffset: number;
  readonly endOffset: number;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  readonly similarity: number;
}

export interface SearchRepository {
  /**
   * Nearest chunks of the workspace's live documents: only the active, ready version, only
   * vectors of `model`. Authorization is part of the query, not applied afterwards.
   */
  nearest(input: {
    readonly workspaceId: string;
    readonly model: string;
    readonly embedding: readonly number[];
    readonly limit: number;
  }): Promise<readonly SearchHit[]>;
}

export interface SearchChunksDeps {
  readonly uow: UnitOfWork<{ search: SearchRepository }>;
  readonly embedder: Embedder;
}

/** A blank or oversized query, or a limit outside 1..maxSearchLimit. */
export class InvalidSearch extends DomainError {
  constructor() {
    super("search.invalid", "Invalid search request");
  }
}

export async function searchChunks(
  deps: SearchChunksDeps,
  actor: Actor,
  input: { readonly query: string; readonly limit?: number | undefined },
): Promise<readonly SearchHit[]> {
  assertCan(actor, "document.read");
  const query = input.query.trim();
  const limit = input.limit ?? defaultSearchLimit;
  if (query === "" || query.length > maxQueryLength) throw new InvalidSearch();
  if (!Number.isInteger(limit) || limit < 1 || limit > maxSearchLimit) throw new InvalidSearch();
  // The network call happens before the transaction opens: none is held across it.
  const [embedding] = await deps.embedder.embed([query]);
  if (embedding === undefined) throw new Error("Embedder returned no vector");
  return deps.uow.run({ userId: actor.userId, workspaceId: actor.workspaceId }, (repos) =>
    repos.search.nearest({
      workspaceId: actor.workspaceId,
      model: deps.embedder.model,
      embedding,
      limit,
    }),
  );
}
