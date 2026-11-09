import {
  HashingBusy,
  InvalidCredentials,
  PermissionDenied,
  StorageError,
  type StorageErrorCode,
  Unauthenticated,
  UploadRejected,
  type UploadRejectionCode,
  WorkspaceAccessDenied,
} from "@contextvault/domain";
import { ForbiddenException, HttpException, Logger } from "@nestjs/common";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-error";
import { ErrorFilter } from "./error.filter";
import { bindRequestId } from "./request-id";

interface Sent {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function run(error: unknown, requestId?: string): Sent {
  const req = {};
  if (requestId !== undefined) bindRequestId(req, requestId);
  const sent: Sent = { status: 0, headers: {}, body: undefined };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    setHeader(name: string, value: string) {
      sent.headers[name] = value;
    },
    json(body: unknown) {
      sent.body = body;
    },
  };
  new ErrorFilter().catch(error, new ExecutionContextHost([req, reply]));
  return sent;
}

const reply = (status: number, code: string, headers: Record<string, string> = {}) => ({
  status,
  headers,
  body: { error: { code, requestId: "r1" } },
});

beforeEach(() => {
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("ErrorFilter classification", () => {
  it.each([
    ["InvalidCredentials", new InvalidCredentials(), 401, "auth.invalid_credentials"],
    ["Unauthenticated", new Unauthenticated(), 401, "auth.unauthenticated"],
    ["PermissionDenied", new PermissionDenied("document.upload"), 403, "permission.denied"],
    ["WorkspaceAccessDenied", new WorkspaceAccessDenied(), 404, "not_found"],
    [
      "storage.unavailable",
      new StorageError("storage.unavailable", true),
      503,
      "storage.unavailable",
    ],
    ["storage.rejected", new StorageError("storage.rejected", false), 503, "storage.unavailable"],
    ["plain Error", new Error("boom"), 500, "internal"],
  ])("%s", (_name, error, status, code) => {
    expect(run(error, "r1")).toEqual(reply(status, code));
  });

  it("maps HashingBusy to 429 with Retry-After", () => {
    expect(run(new HashingBusy(), "r1")).toEqual(
      reply(429, "auth.throttled", { "Retry-After": "1" }),
    );
  });

  it("passes an ApiError through with a copy of its headers", () => {
    const headers = { "Retry-After": "30" };
    const sent = run(new ApiError(429, "auth.throttled", headers), "r1");
    expect(sent).toEqual(reply(429, "auth.throttled", { "Retry-After": "30" }));
    expect(sent.headers).not.toBe(headers);
  });

  it.each([
    ["upload.too_large", 413, "upload.too_large"],
    ["upload.content_mismatch", 422, "upload.content_mismatch"],
    ["upload.quota_bytes", 409, "upload.quota_bytes"],
    ["upload.client_disconnected", 400, "upload.incomplete"],
    ["upload.idle_timeout", 400, "upload.incomplete"],
    ["upload.deadline_exceeded", 400, "upload.incomplete"],
    ["storage.unavailable", 503, "storage.unavailable"],
  ] satisfies [UploadRejectionCode, number, string][])(
    "maps UploadRejected %s",
    (rejected, status, code) => {
      expect(run(new UploadRejected(rejected), "r1")).toEqual(reply(status, code));
    },
  );

  it.each([
    [404, 404, "not_found"],
    [413, 413, "request.too_large"],
    [400, 400, "request.invalid"],
    [401, 401, "request.invalid"],
    [429, 429, "request.invalid"],
    [499, 499, "request.invalid"],
    [500, 500, "internal"],
    [502, 500, "internal"],
  ])("maps HttpException %i", (httpStatus, status, code) => {
    expect(run(new HttpException("x", httpStatus), "r1")).toEqual(reply(status, code));
  });

  it("maps a Nest ForbiddenException to request.invalid", () => {
    expect(run(new ForbiddenException(), "r1")).toEqual(reply(403, "request.invalid"));
  });

  it.each<StorageErrorCode>(["storage.conflict", "storage.invalid_key", "storage.length_mismatch"])(
    "does not expose a non-operational StorageError (%s)",
    (code) => {
      expect(run(new StorageError(code, false), "r1")).toEqual(reply(500, "internal"));
    },
  );

  it.each([undefined, null, "text", 42, {}])("falls back to 500 for a thrown %s", (thrown) => {
    expect(run(thrown, "r1")).toEqual(reply(500, "internal"));
  });
});

describe("ErrorFilter response and logging", () => {
  it("uses 'unknown' when no request id was bound", () => {
    expect(run(new Error("x"))).toMatchObject({ body: { error: { requestId: "unknown" } } });
  });

  it("never sends or logs messages, causes or stacks", () => {
    const logged: string[] = [];
    vi.spyOn(Logger.prototype, "error").mockImplementation((m) => void logged.push(String(m)));
    const secret = "postgres://user:hunter2@host/db";
    const error = new Error(secret, { cause: new Error(secret) });
    const sent = run(error, "r1");
    expect(sent.body).toEqual({ error: { code: "internal", requestId: "r1" } });
    expect(JSON.stringify(sent)).not.toContain("hunter2");
    expect(logged).toEqual([JSON.stringify({ code: "internal", requestId: "r1" })]);
  });

  it("logs errors only for 5xx and warns with the real code for interruptions", () => {
    const errors = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const warns = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    run(new InvalidCredentials(), "r1");
    run(new UploadRejected("upload.too_large"), "r1");
    expect(errors).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
    run(new UploadRejected("upload.idle_timeout"), "r1");
    expect(warns).toHaveBeenCalledWith(
      JSON.stringify({ code: "upload.idle_timeout", requestId: "r1" }),
    );
    run(new StorageError("storage.unavailable", true), "r1");
    expect(errors).toHaveBeenCalledWith(
      JSON.stringify({ code: "storage.unavailable", requestId: "r1" }),
    );
  });
});
