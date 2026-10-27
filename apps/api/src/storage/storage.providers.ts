import type { ApiEnv } from "@contextvault/config";
import { MAX_UPLOAD_BYTES } from "@contextvault/contracts";
import type { DocumentStore } from "@contextvault/domain";
import type { Provider } from "@nestjs/common";
import { ENV } from "../auth/tokens";
import { createS3DocumentStore } from "./s3-document-store";
import { DOCUMENT_STORE } from "./tokens";

// Composition root for object storage; `main.ts` runs the bucket check before listening.
// `store` is a seam for tests that inject faults around the real adapter.
export const storageProviders = (store?: DocumentStore): Provider[] => [
  {
    provide: DOCUMENT_STORE,
    inject: [ENV],
    useFactory: (env: ApiEnv) =>
      store ?? createS3DocumentStore(env, { maxBytes: MAX_UPLOAD_BYTES }),
  },
];
