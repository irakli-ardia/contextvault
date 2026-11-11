import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { S3Env } from "@contextvault/config";

export interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  body: Buffer;
  complete: boolean;
}

export type Handler = (request: IncomingMessage, response: ServerResponse, seen: Seen) => void;

export interface FakeS3 {
  readonly env: S3Env;
  readonly seen: Seen[];
  readonly close: () => Promise<void>;
}

export const SECRET = "fake-secret-key-must-not-leak";

// A loopback HTTP server that plays the part of the provider, so the real SDK runs end to end
// without Docker. `handler` decides the answer; `seen` records what arrived and whether the
// request body completed.
export async function startFakeS3(handler: Handler): Promise<FakeS3> {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const entry: Seen = {
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: Buffer.alloc(0),
      complete: false,
    };
    seen.push(entry);
    request.on("data", (chunk: Buffer) => {
      entry.body = Buffer.concat([entry.body, chunk]);
    });
    request.on("end", () => {
      entry.complete = true;
    });
    request.on("error", () => {});
    handler(request, response, entry);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake S3 did not bind");
  const { port } = address;
  return {
    seen,
    env: {
      NODE_ENV: "test",
      S3_ENDPOINT: `http://127.0.0.1:${port}`,
      S3_REGION: "us-east-1",
      S3_BUCKET: "private-bucket",
      S3_ACCESS_KEY_ID: "fake-access-key",
      S3_SECRET_ACCESS_KEY: SECRET,
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
