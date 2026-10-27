import type { IncomingMessage } from "node:http";
import { parseUploadHeaders } from "@contextvault/contracts";
import {
  type Actor,
  assertCan,
  type UploadDocumentDeps,
  uploadDocument,
} from "@contextvault/domain";
import { Controller, Inject, Logger, Post, Req, Res } from "@nestjs/common";
import { ApiError } from "../auth/api-error";
import { CurrentActor, requestIdOf } from "../auth/request-state";
import type { UploadTimeouts } from "./documents.providers";
import { requestBody } from "./request-body";
import { UPLOAD_DEPS, UPLOAD_TIMEOUTS } from "./tokens";
import { UploadLimiter } from "./upload-limiter";

interface Reply {
  status(code: number): unknown;
}

const single = (value: string | string[] | undefined): string | null =>
  typeof value === "string" ? value : null;

// Transport only: validates framing, takes a slot, hands the raw request stream to the use case.
// Guards (Origin, session, membership) have run before this method; the body is still unread.
@Controller("workspaces/:workspaceId/uploads")
export class UploadsController {
  private readonly logger = new Logger("Api");

  constructor(
    @Inject(UPLOAD_DEPS) private readonly deps: UploadDocumentDeps,
    @Inject(UPLOAD_TIMEOUTS) private readonly timeouts: UploadTimeouts,
    @Inject(UploadLimiter) private readonly limiter: UploadLimiter,
  ) {}

  @Post()
  async upload(
    @CurrentActor() actor: Actor,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: Reply,
  ) {
    const parsed = parseUploadHeaders({ get: (name) => single(req.headers[name]) });
    if (!parsed.ok) throw new ApiError(parsed.refusal.status, parsed.refusal.code);
    const { contentType, contentLength, encodedFilename } = parsed.value;
    // Before a slot or any storage work; the use case checks again.
    assertCan(actor, "document.upload");

    const release = this.limiter.acquire(actor.userId);
    try {
      const deadline = AbortSignal.timeout(this.timeouts.totalMs);
      const requestId = requestIdOf(req);
      const result = await uploadDocument(
        {
          ...this.deps,
          onRetained: (event) =>
            this.logger.warn(
              JSON.stringify({ code: "upload.reservation_retained", requestId, ...event }),
            ),
        },
        {
          actor,
          fileName: decodeURIComponent(encodedFilename),
          contentType,
          declaredBytes: contentLength,
          body: requestBody(req, { idleMs: this.timeouts.idleMs, deadline }),
          signal: deadline,
        },
      );
      res.status(result.outcome === "created" ? 201 : 200);
      const { id, displayName, mime, sizeBytes, status, createdAt } = result.document;
      return { id, displayName, mime, sizeBytes, status, createdAt };
    } finally {
      release();
    }
  }
}
