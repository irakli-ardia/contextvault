import type { HttpResponse } from "../auth/http-types";

// An upload may be answered before its body is read (bad session, bad headers, busy). Closing the
// connection afterwards stops Node from keeping it open for, or draining, an unread body.
export function closeConnection(_req: object, res: HttpResponse, next: () => void): void {
  res.setHeader("Connection", "close");
  next();
}
