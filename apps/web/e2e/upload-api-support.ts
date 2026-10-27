import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import type { Page } from "@playwright/test";

export const web = "http://127.0.0.1:3100";

export interface Stored {
  id: string;
  displayName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  status: string;
  storageKey: string;
}
export interface Reservation {
  id: string;
  storageKey: string;
  declaredBytes: number;
}
// The database as the operator sees it (bundled fixture tool, read only).
function inspect(workspaceId: string): { documents: Stored[]; pending: Reservation[] } {
  const out = execFileSync(
    "node",
    ["--env-file-if-exists=.env", "packages/db/dist/e2e-accounts.mjs", "inspect", workspaceId],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return JSON.parse(out)[0];
}
export const stored = (workspaceId: string): Stored[] => inspect(workspaceId).documents;
/** Pending uploads: the reservations that count against the workspace quota. */
export const reservations = (workspaceId: string): Reservation[] => inspect(workspaceId).pending;

export const pdf = (fill: number) =>
  Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4096, fill)]);
export const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

// A real browser `fetch` with a Blob body: the browser sets Content-Length, Origin and cookies.
export function browserUpload(
  page: Page,
  workspaceId: string,
  file: { name: string; type: string; bytes?: Buffer; size?: number },
) {
  return page.evaluate(
    async ({ workspaceId, name, type, base64, size }) => {
      const data =
        base64 === null
          ? new Uint8Array(size ?? 0).fill(0x41)
          : Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const res = await fetch(`/api/workspaces/${workspaceId}/uploads`, {
        method: "POST",
        headers: { "content-type": type, "x-filename": encodeURIComponent(name) },
        body: new Blob([data], { type }),
      });
      const text = await res.text();
      return { status: res.status, text, body: JSON.parse(text) };
    },
    {
      workspaceId,
      name: file.name,
      type: file.type,
      base64: file.bytes?.toString("base64") ?? null,
      size: file.size ?? null,
    },
  );
}

// What a browser cannot do: lie about the length, or forge an Origin. Plain HTTP to the web origin.
export function raw(
  cookie: string,
  workspaceId: string,
  options: { origin?: string; declared: number; send: Buffer; abort?: boolean },
) {
  return new Promise<number>((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: 3100,
        path: `/api/workspaces/${workspaceId}/uploads`,
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/pdf",
          "content-length": String(options.declared),
          "x-filename": "t.pdf",
          origin: options.origin ?? web,
          cookie,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", () => resolve(0));
    req.write(options.send);
    if (options.abort) setTimeout(() => req.destroy(), 150);
    else req.end();
  });
}

/** A started upload that sends part of its body and stays open until `abort()`. */
export function hold(cookie: string, workspaceId: string, declared: number, send: Buffer) {
  const req = http.request({
    host: "127.0.0.1",
    port: 3100,
    path: `/api/workspaces/${workspaceId}/uploads`,
    method: "POST",
    agent: false,
    headers: {
      "content-type": "application/pdf",
      "content-length": String(declared),
      "x-filename": "t.pdf",
      origin: web,
      cookie,
    },
  });
  req.on("error", () => undefined);
  req.on("response", (res) => res.resume());
  req.write(send);
  return { abort: () => req.destroy() };
}

export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}
