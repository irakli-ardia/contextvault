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
import { ApiError } from "./api-error";
import type { HttpRequest } from "./http-types";
import { requestIdOf } from "./request-id";
import { isInterruption, uploadStatusOf } from "./upload-errors";

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

type Rule = (error: unknown) => Classified | undefined;

const when =
  <T extends Error>(
    type: new (...args: never[]) => T,
    map: (error: T) => Classified | undefined,
  ): Rule =>
  (error) =>
    error instanceof type ? map(error) : undefined;

const known = (status: number, code: string): Classified => ({ status, code, headers: {} });

// First match wins; the order is the precedence.
const rules: readonly Rule[] = [
  when(ApiError, (e) => ({ status: e.status, code: e.code, headers: { ...e.headers } })),
  when(InvalidCredentials, (e) => known(401, e.code)),
  when(Unauthenticated, (e) => known(401, e.code)),
  when(PermissionDenied, (e) => known(403, e.code)),
  // A non-member, a missing workspace, a malformed id, and an unknown route are one answer.
  when(WorkspaceAccessDenied, () => known(404, "not_found")),
  when(HashingBusy, () => ({ ...known(429, "auth.throttled"), headers: { "Retry-After": "1" } })),
  (error) => {
    const upload = uploadStatusOf(error);
    return upload && { ...upload, headers: {} };
  },
  // Storage unreachable or refusing us is an operational failure, not a client error.
  when(StorageError, (e) =>
    ["storage.unavailable", "storage.rejected"].includes(e.code)
      ? known(503, "storage.unavailable")
      : undefined,
  ),
  when(HttpException, (e) => fromHttpException(e.getStatus())),
];

function classify(error: unknown): Classified {
  for (const rule of rules) {
    const classified = rule(error);
    if (classified) return classified;
  }
  return known(500, "internal");
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
