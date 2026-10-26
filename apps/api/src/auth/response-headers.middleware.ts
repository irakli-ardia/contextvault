import { randomUUID } from "node:crypto";
import type { HttpResponse } from "./http-types";
import { bindRequestId } from "./request-state";

// Every response is uncacheable and unsniffable; the request id is minted here, never read from
// the client.
export function responseHeaders(req: object, res: HttpResponse, next: () => void): void {
  const id = randomUUID();
  bindRequestId(req, id);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Request-Id", id);
  next();
}
