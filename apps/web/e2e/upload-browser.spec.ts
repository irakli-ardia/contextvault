import { MAX_UPLOAD_BYTES } from "@contextvault/contracts";
import { expect, test } from "@playwright/test";
import { createStub } from "./upload-stub";

const stub = createStub(3199);
const web = "http://127.0.0.1:3101";
const workspace = "0f6c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5";
const path = `/api/workspaces/${workspace}/uploads`;

test.beforeAll(() => stub.start());
test.afterAll(() => stub.stop());
test.beforeEach(() => stub.reset());

// A real Chromium `fetch` is the only client that proves what browsers do with the contract.
const upload = (page: import("@playwright/test").Page, size: number, headers = {}) =>
  page.evaluate(
    async ({ size, headers, path }) => {
      const blob = new Blob([new Uint8Array(size).fill(7)], { type: "application/pdf" });
      try {
        const res = await fetch(path, {
          method: "POST",
          headers: { "x-filename": "r.pdf", ...headers },
          body: blob,
        });
        return { status: res.status, code: (await res.json()).error?.code ?? null };
      } catch (error) {
        return { status: 0, code: error instanceof TypeError ? "network-error" : "other" };
      }
    },
    { size, headers, path },
  );

test.describe("the browser", () => {
  test("a Blob body is sent with Content-Length, the real Origin and the cookie jar", async ({
    page,
    context,
  }) => {
    await context.addCookies([{ name: "cv_session", value: "jar-cookie", url: web }]);
    await page.goto(web);
    const result = await upload(page, MAX_UPLOAD_BYTES);
    expect(result.status).toBe(201);
    const [seen] = stub.seen;
    expect(seen?.headers["content-length"]).toBe(String(MAX_UPLOAD_BYTES));
    expect(seen?.headers["transfer-encoding"]).toBeUndefined();
    expect(seen?.headers["content-type"]).toBe("application/pdf");
    expect(seen?.headers.origin).toBe(web);
    expect(seen?.headers.cookie).toBe("cv_session=jar-cookie");
    expect(seen?.bytes).toBe(MAX_UPLOAD_BYTES);
  });

  test("Chromium cannot send a chunked body over HTTP/1.1, so Content-Length is always present", async ({
    page,
  }) => {
    await page.goto(web);
    const outcome = await page.evaluate(async (path) => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024));
          controller.close();
        },
      });
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        body,
        duplex: "half",
        headers: { "content-type": "application/pdf", "x-filename": "r.pdf" },
      };
      try {
        return `status ${(await fetch(path, init)).status}`;
      } catch (error) {
        return error instanceof TypeError ? "network-error" : "other";
      }
    }, path);
    expect(outcome).toBe("network-error");
    expect(stub.seen).toHaveLength(0);
  });

  test("an oversized Blob is refused with 413 and the API is never contacted", async ({ page }) => {
    await page.goto(web);
    expect(await upload(page, MAX_UPLOAD_BYTES + 1)).toEqual({
      status: 413,
      code: "upload.too_large",
    });
    expect(stub.seen).toHaveLength(0);
  });

  test("a rejection sent before the body is read reaches page code as its HTTP status", async ({
    page,
  }) => {
    stub.control.mode = "early401";
    await page.goto(web);
    // The API answers before it reads a byte of the 10 MiB body, and the connection is then reset
    // while the browser is still writing. Chromium still reports the status, not a network error
    // (every measured run, 9 of 9; the ADR 0009 claim). A network error here is a regression to
    // investigate, not a tolerated outcome.
    expect(await upload(page, MAX_UPLOAD_BYTES)).toEqual({
      status: 401,
      code: "auth.unauthenticated",
    });
  });
});

test.describe("the real API behind the same origin", () => {
  test("an upload to the real stack is answered by NestJS, through the unchanged proxy", async ({
    page,
  }) => {
    await page.goto("/");
    const reply = await page.evaluate(async (path) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "text/plain", "x-filename": "a.txt" },
        body: new Blob(["hello"], { type: "text/plain" }),
      });
      return {
        status: res.status,
        requestId: res.headers.get("x-request-id"),
        text: await res.text(),
      };
    }, path);
    // TEMPORARY (M1.3e replaces this): no upload endpoint exists yet, so NestJS answers with its own
    // not-found shape and request id. This is the real Next -> NestJS hop, not the stub. When the
    // endpoint lands, this test becomes a successful authenticated upload (see the M1.3 plan).
    expect(reply.status).toBe(404);
    expect(reply.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(reply.text).error).toMatchObject({
      code: "not_found",
      requestId: reply.requestId,
    });
    expect(reply.text).not.toMatch(/3001|127\.0\.0\.1/);
  });

  test("the rewrite still proxies the rest of /api (moved to the fallback phase)", async ({
    request,
  }) => {
    const me = await request.get("/api/auth/me");
    expect(me.status()).toBe(401);
    expect((await me.json()).error.code).toBe("auth.unauthenticated");
    expect(me.headers()["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
