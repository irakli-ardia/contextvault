import {
  HashingBusy,
  InvalidCredentials,
  PermissionDenied,
  StorageError,
  Unauthenticated,
  WorkspaceAccessDenied,
} from "@contextvault/domain";
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { isInterruption, uploadStatusOf } from "../documents/upload-errors";
import { ApiError } from "./api-error";
import type { HttpRequest } from "./http-types";
import { requestIdOf } from "./request-state";

interface Classified {
  status: number;
  code: string;
  headers: Record<string, string>;
}

interface Reply {
  status(code: number): Reply;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

function fromHttpException(status: number): Classified {
  if (status >= 500) return { status: 500, code: "internal", headers: {} };
  if (status === 404) return { status, code: "not_found", headers: {} };
  if (status === 413) return { status, code: "request.too_large", headers: {} };
  return { status, code: "request.invalid", headers: {} };
}

function classify(error: unknown): {
  status: number;
  code: string;
  headers: Record<string, string>;
} {
  if (error instanceof ApiError)
    return { status: error.status, code: error.code, headers: { ...error.headers } };
  if (error instanceof InvalidCredentials) return { status: 401, code: error.code, headers: {} };
  if (error instanceof Unauthenticated) return { status: 401, code: error.code, headers: {} };
  if (error instanceof PermissionDenied) return { status: 403, code: error.code, headers: {} };
  // A non-member, a missing workspace, a malformed id, and an unknown route are one answer.
  if (error instanceof WorkspaceAccessDenied)
    return { status: 404, code: "not_found", headers: {} };
  if (error instanceof HashingBusy) {
    return { status: 429, code: "auth.throttled", headers: { "Retry-After": "1" } };
  }
  const upload = uploadStatusOf(error);
  if (upload) return { ...upload, headers: {} };
  // Storage unreachable or refusing us is an operational failure, not a client error.
  if (
    error instanceof StorageError &&
    ["storage.unavailable", "storage.rejected"].includes(error.code)
  ) {
    return { status: 503, code: "storage.unavailable", headers: {} };
  }
  if (error instanceof HttpException) return fromHttpException(error.getStatus());
  return { status: 500, code: "internal", headers: {} };
}

// Replies with a stable code and the request id only. Messages, causes, stacks, and request data
// never leave the process: they can carry credentials or document text.
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("Api");

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const requestId = requestIdOf(http.getRequest<HttpRequest>());
    const { status, code, headers } = classify(error);
    if (status >= 500) this.logger.error(JSON.stringify({ code, requestId }));
    // The client sees `upload.incomplete`; operators see which interruption it was.
    if (isInterruption(error)) this.logger.warn(JSON.stringify({ code: error.code, requestId }));
    const reply = http.getResponse<Reply>();
    for (const [name, value] of Object.entries(headers)) reply.setHeader(name, value);
    reply.status(status).json({ error: { code, requestId } });
  }
}
