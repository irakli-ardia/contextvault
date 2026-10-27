import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";

const webPort = 3101;
export const workspace = "0f6c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5";
export const uploadPath = `/api/workspaces/${workspace}/uploads`;

/** Deterministic non-constant content, so a dropped or reordered chunk changes the hash. */
export function pattern(size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + (i >> 8)) & 0xff;
  return out;
}

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface Send {
  path?: string;
  method?: string;
  headers?: Record<string, string | undefined>;
  /** Body bytes; Content-Length is set to this unless `headers` overrides it. */
  body?: Buffer;
  /** When set, send only this many bytes and then destroy the connection. */
  abortAfter?: number;
  /** Stop writing at `at` bytes (a multiple of 64 KiB) until `wait` settles, then send the rest. */
  gate?: { at: number; wait: Promise<unknown> };
}

const baseHeaders = {
  "content-type": "application/pdf",
  "x-filename": "report.pdf",
  origin: `http://127.0.0.1:${webPort}`,
};

export function send(options: Send = {}): Promise<Reply> {
  const body = options.body ?? pattern(1024);
  const headers = { ...baseHeaders, "content-length": String(body.length), ...options.headers };
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: webPort,
        path: options.path ?? uploadPath,
        method: options.method ?? "POST",
        headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)),
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          text += d;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
      },
    );
    req.on("error", (error) =>
      options.abortAfter === undefined ? reject(error) : resolve(aborted),
    );
    const limit = options.abortAfter ?? body.length;
    let offset = 0;
    let gated = options.gate === undefined;
    const step = () => {
      while (offset < limit) {
        if (!gated && options.gate && offset === options.gate.at) {
          gated = true;
          return void options.gate.wait.then(step, reject);
        }
        const end = Math.min(offset + 64 * 1024, limit);
        const ok = req.write(body.subarray(offset, end));
        offset = end;
        if (!ok) return void req.once("drain", step);
      }
      if (options.abortAfter !== undefined) {
        setTimeout(() => req.destroy(), 50);
        return;
      }
      req.end();
    };
    step();
  });
}

const aborted: Reply = { status: 0, headers: {}, body: "" };

/** A hand-written request, for framing no HTTP client will produce. Returns the status line. */
export function raw(text: string): Promise<{ status: number; head: string }> {
  return new Promise((resolve) => {
    const socket = net.connect(webPort, "127.0.0.1", () => socket.write(text));
    let data = "";
    socket.setEncoding("utf8");
    socket.setTimeout(3000, () => socket.destroy());
    socket.on("data", (d: string) => {
      data += d;
    });
    socket.on("close", () => {
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0), head: data });
    });
    socket.on("error", () => undefined);
  });
}
