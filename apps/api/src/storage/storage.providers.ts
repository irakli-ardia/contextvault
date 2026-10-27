import type { ApiEnv } from "@contextvault/config";
import { MAX_UPLOAD_BYTES } from "@contextvault/contracts";
import type { Provider } from "@nestjs/common";
import { ENV } from "../auth/tokens";
import { createS3DocumentStore } from "./s3-document-store";
import { DOCUMENT_STORE } from "./tokens";

// Composition root for object storage. Consumers arrive with the upload use case (M1.3d/e);
// `main.ts` runs the bucket check before listening.
export const storageProviders: Provider[] = [
  {
    provide: DOCUMENT_STORE,
    inject: [ENV],
    useFactory: (env: ApiEnv) => createS3DocumentStore(env, { maxBytes: MAX_UPLOAD_BYTES }),
  },
];
