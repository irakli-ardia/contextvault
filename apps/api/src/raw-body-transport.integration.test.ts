import "reflect-metadata";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { parseApiEnv } from "@contextvault/config";
import { MAX_UPLOAD_BYTES } from "@contextvault/contracts";
import { Controller, Module, Post, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureApp } from "./configure-app";

// The upload endpoint arrives in M1.3e. This probe lives only in this test and answers one
// question about the real NestJS/Express stack the endpoint will sit on: does a raw body with a
// Content-Length reach a controller untouched, for each accepted content type?
@Controller("probe")
class ProbeController {
  @Post("raw")
  async raw(@Req() req: IncomingMessage) {
    let bytes = 0;
    let first = 0;
    for await (const chunk of req) {
      const data: Buffer = chunk;
      if (bytes === 0) first = data[0] ?? -1;
      bytes += data.length;
    }
    return {
      bytes,
      first,
      contentLength: req.headers["content-length"] ?? null,
      transferEncoding: req.headers["transfer-encoding"] ?? null,
    };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

let app: NestExpressApplication;
let port = 0;

beforeAll(async () => {
  const env = parseApiEnv({
    NODE_ENV: "test",
    API_PORT: "3001",
    API_HOST: "127.0.0.1",
    WEB_ORIGIN: "http://127.0.0.1:3000",
    DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
    S3_ENDPOINT: "http://127.0.0.1:1",
    S3_BUCKET: "unused",
    S3_ACCESS_KEY_ID: "unused",
    S3_SECRET_ACCESS_KEY: "unused",
  });
  app = await NestFactory.create<NestExpressApplication>(ProbeModule, { logger: false });
  configureApp(app, env);
  await app.listen(0, "127.0.0.1");
  const address: AddressInfo | string | null = app.getHttpServer().address();
  if (address === null || typeof address === "string") throw new Error("no port");
  port = address.port;
});

afterAll(() => app.close());

function post(contentType: string, body: Buffer, chunked = false) {
  return new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": contentType };
    if (!chunked) headers["content-length"] = String(body.length);
    const req = http.request(
      { host: "127.0.0.1", port, path: "/probe/raw", method: "POST", headers },
      (res) => {
        let text = "";
        res.on("data", (d: Buffer) => {
          text += d.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    // Two writes: a single `end(body)` lets Node add a Content-Length itself.
    req.write(body.subarray(0, 5));
    req.end(body.subarray(5));
  });
}

describe("raw upload bodies through NestJS", () => {
  it.each(["application/pdf", "text/markdown", "text/plain; charset=utf-8"])(
    "delivers the whole %s body to the controller with its Content-Length",
    async (type) => {
      const body = Buffer.alloc(MAX_UPLOAD_BYTES, 0x25);
      const { status, json } = await post(type, body);
      expect(status).toBe(201);
      expect(json).toEqual({
        bytes: MAX_UPLOAD_BYTES,
        first: 0x25,
        contentLength: String(MAX_UPLOAD_BYTES),
        transferEncoding: null,
      });
    },
  );

  it("shows a chunked body as Transfer-Encoding with no Content-Length, so the endpoint can refuse it", async () => {
    const { json } = await post("application/pdf", Buffer.alloc(10), true);
    expect(json).toMatchObject({ contentLength: null, transferEncoding: "chunked" });
  });
});
