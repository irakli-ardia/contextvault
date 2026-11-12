import { createHash, randomUUID } from "node:crypto";
import type { Persistence } from "@contextvault/db";
import type { DocumentStore, UploadDocumentDeps } from "@contextvault/domain";
import type { Provider } from "@nestjs/common";
import { PERSISTENCE } from "../auth/tokens";
import { DOCUMENT_STORE } from "../storage/tokens";
import { MAX_SEARCHES_PER_USER, RetryLimiter } from "./retry-limiter";
import { ANSWER_LIMITER, SEARCH_LIMITER, UPLOAD_DEPS, UPLOAD_TIMEOUTS } from "./tokens";
import { UploadLimiter } from "./upload-limiter";

export interface UploadTimeouts {
  /** No body bytes for this long. */
  readonly idleMs: number;
  /** The whole operation, from the first guarded byte to the finished response. */
  readonly totalMs: number;
}

const defaultUploadTimeouts: UploadTimeouts = { idleMs: 15_000, totalMs: 120_000 };

// Composition root for the upload use case: persistence, private storage, and the two services the
// domain cannot import (random ids, SHA-256). `timeouts` and `searchLimiter` are seams for tests.
export function documentProviders(
  timeouts: UploadTimeouts = defaultUploadTimeouts,
  searchLimiter?: RetryLimiter,
): Provider[] {
  return [
    UploadLimiter,
    { provide: RetryLimiter, useFactory: () => new RetryLimiter() },
    // Each answer can be a paid model call, so it is throttled like a retry: per user, per minute.
    { provide: ANSWER_LIMITER, useFactory: () => new RetryLimiter(Date.now, "answer.throttled") },
    // Vector and hybrid search each embed the query (a paid call with a real provider) and every
    // mode scans the workspace, so search is throttled per user, more generously than answers.
    {
      provide: SEARCH_LIMITER,
      useFactory: () =>
        searchLimiter ?? new RetryLimiter(Date.now, "search.throttled", MAX_SEARCHES_PER_USER),
    },
    { provide: UPLOAD_TIMEOUTS, useValue: timeouts },
    {
      provide: UPLOAD_DEPS,
      inject: [PERSISTENCE, DOCUMENT_STORE],
      useFactory: (persistence: Persistence, store: DocumentStore): UploadDocumentDeps => ({
        uow: persistence.unitOfWork,
        store,
        services: {
          newId: randomUUID,
          newSha256: () => {
            const hash = createHash("sha256");
            return {
              update: (chunk) => {
                hash.update(chunk);
              },
              digest: () => hash.digest(),
            };
          },
        },
      }),
    },
  ];
}
