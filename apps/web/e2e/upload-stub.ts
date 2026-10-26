import { createHash } from "node:crypto";
import http, { type IncomingHttpHeaders } from "node:http";

// Test-only stand-in for the API's upload endpoint, which does not exist yet. It records exactly
// what the web transport delivered and misbehaves on demand. It is never part of the product.

type StubMode =
  | "ok"
  | "slow" // reads 64 KiB per `delayMs`
  | "early401" // answers before reading the body
  | "error500" // JSON 500 after reading
  | "redirect" // 302 pointing at an internal address
  | "html" // non-JSON failure page naming an internal path
  | "hostile" // 201 with headers the transport must not relay
  | "destroy"; // kills the socket at the first byte

interface Seen {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly rawHeaderNames: string[];
  bytes: number;
  aborted: boolean;
  finished: boolean;
  firstByteAt: number;
  endedAt: number;
  readonly startedAt: number;
  sha256: string;
}

const json = (res: http.ServerResponse, status: number, body: unknown, extra = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify(body));
};

export function createStub(port: number) {
  const seen: Seen[] = [];
  const control: { mode: StubMode; delayMs: number } = { mode: "ok", delayMs: 15 };

  const server = http.createServer((req, res) => {
    const hash = createHash("sha256");
    const entry: Seen = {
      url: req.url ?? "",
      headers: req.headers,
      rawHeaderNames: req.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase()),
      bytes: 0,
      aborted: false,
      finished: false,
      firstByteAt: 0,
      endedAt: 0,
      startedAt: Date.now(),
      sha256: "",
    };
    seen.push(entry);
    const { mode } = control;
    req.on("aborted", () => {
      entry.aborted = true;
    });
    if (mode === "early401") {
      return json(res, 401, { error: { code: "auth.unauthenticated", requestId: "stub-401" } });
    }
    req.on("data", (chunk: Buffer) => {
      if (entry.firstByteAt === 0) entry.firstByteAt = Date.now();
      entry.bytes += chunk.length;
      hash.update(chunk);
      if (mode === "destroy") req.socket.destroy();
      if (mode === "slow") {
        req.pause();
        setTimeout(() => req.resume(), control.delayMs);
      }
    });
    req.on("end", () => {
      entry.endedAt = Date.now();
      entry.finished = true;
      entry.sha256 = hash.digest("hex");
      const requestId = "stub-1";
      if (mode === "error500") {
        return json(
          res,
          500,
          { error: { code: "internal", requestId } },
          { "x-request-id": requestId },
        );
      }
      if (mode === "redirect") {
        res.writeHead(302, { location: "http://127.0.0.1:3001/secret" });
        return res.end();
      }
      if (mode === "html") {
        res.writeHead(500, { "content-type": "text/html" });
        return res.end("<pre>Error at /srv/api/internal/stack.js:1 (127.0.0.1:3199)</pre>");
      }
      const extra =
        mode === "hostile"
          ? {
              "set-cookie": "cv_session=evil; Path=/",
              server: "internal-api/9.9",
              "x-powered-by": "Express",
              "x-internal": "127.0.0.1:3199",
            }
          : {};
      json(res, 201, { ok: true }, { "x-request-id": requestId, ...extra });
    });
  });

  return {
    seen,
    control,
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(port, "127.0.0.1", resolve);
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    reset: () => {
      seen.length = 0;
      control.mode = "ok";
      control.delayMs = 15;
    },
  };
}
