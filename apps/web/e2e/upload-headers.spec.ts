import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { pattern, raw, send, uploadPath, workspace } from "./upload-client";
import { createStub } from "./upload-stub";

const stub = createStub(3199);
test.beforeAll(() => stub.start());
test.afterAll(() => stub.stop());
test.beforeEach(() => stub.reset());

test.describe("headers", () => {
  test("Origin and Cookie reach the API unchanged, and absence stays absence", async () => {
    const cookie = "cv_session=abc123; theme=dark";
    await send({ headers: { cookie, origin: "http://127.0.0.1:3101" } });
    expect(stub.seen[0]?.headers).toMatchObject({ cookie, origin: "http://127.0.0.1:3101" });

    stub.reset();
    await send({ headers: { origin: undefined } });
    expect(stub.seen[0]?.headers.origin).toBeUndefined();
    expect(stub.seen[0]?.headers.cookie).toBeUndefined();
  });

  test("a foreign Origin is passed on as is, for the API's own check to refuse", async () => {
    await send({ headers: { origin: "http://evil.example" } });
    expect(stub.seen[0]?.headers.origin).toBe("http://evil.example");
  });

  test("forwards the file description and nothing the client chose beyond it", async () => {
    const name = encodeURIComponent("ხელშეკრულება №1.pdf");
    await send({
      headers: {
        "content-type": "Application/PDF; charset=binary",
        "x-filename": name,
        host: "evil.example",
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
        "x-forwarded-port": "1",
        forwarded: "for=203.0.113.9;host=evil.example",
        "x-real-ip": "203.0.113.9",
        "x-original-url": "/admin",
        "x-http-method-override": "DELETE",
        authorization: "Bearer stolen",
        "proxy-authorization": "Basic eA==",
        "x-request-id": "forged",
        "x-middleware-subrequest": "middleware",
        "x-target": "http://evil.example",
      },
    });
    const [seen] = stub.seen;
    expect(seen?.headers["content-type"]).toBe("application/pdf");
    expect(seen?.headers["x-filename"]).toBe(name);
    expect(seen?.headers.host).toBe("127.0.0.1:3199");
    const names = seen?.rawHeaderNames ?? [];
    for (const forbidden of [
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-port",
      "forwarded",
      "x-real-ip",
      "x-original-url",
      "x-http-method-override",
      "authorization",
      "proxy-authorization",
      "x-request-id",
      "x-middleware-subrequest",
      "x-target",
    ]) {
      expect([forbidden, names.includes(forbidden)]).toEqual([forbidden, false]);
    }
    expect(seen?.url).toBe(`/workspaces/${workspace}/uploads`);
  });
});

test.describe("destination", () => {
  test("the API path comes only from the validated workspace id", async () => {
    const hostile = [
      "/api/workspaces/../uploads",
      "/api/workspaces/%2e%2e/uploads",
      "/api/workspaces/..%2f..%2fadmin/uploads",
      `/api/workspaces/${workspace}%2f..%2fadmin/uploads`,
      `/api/workspaces/${workspace.toUpperCase()}/uploads`,
      "/api/workspaces/http:%2f%2fevil.example/uploads",
      "/api/workspaces/not-a-uuid/uploads",
      `/api/workspaces/${workspace}/uploads/extra`,
    ];
    for (const path of hostile) {
      const reply = await send({ path });
      expect([path, reply.status === 404 || reply.status === 308]).toEqual([path, true]);
    }
    expect(stub.seen).toHaveLength(0);
  });

  test("query strings, absolute request targets and Host cannot redirect the request", async () => {
    await send({ path: `${uploadPath}?target=http://evil.example&x=1` });
    expect(stub.seen.map((s) => s.url)).toEqual([`/workspaces/${workspace}/uploads`]);

    const absolute = await raw(
      [
        `POST http://evil.example${uploadPath} HTTP/1.1`,
        "Host: evil.example",
        "Origin: http://127.0.0.1:3101",
        "Content-Type: application/pdf",
        "X-Filename: a.pdf",
        "Content-Length: 5",
        "Connection: close",
        "",
        "hello",
      ].join("\r\n"),
    );
    expect(absolute.status).toBeGreaterThan(0);
    // Whatever the web server made of it, the only destination that can ever be contacted is the
    // configured one, at the one path.
    for (const s of stub.seen) {
      expect(s.url).toBe(`/workspaces/${workspace}/uploads`);
      expect(s.headers.host).toBe("127.0.0.1:3199");
    }
  });

  test("only POST exists, and no CORS header is ever sent", async () => {
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      expect([method, (await send({ method, body: Buffer.alloc(0) })).status]).toEqual([
        method,
        405,
      ]);
    }
    const preflight = await send({
      method: "OPTIONS",
      body: Buffer.alloc(0),
      headers: { origin: "http://evil.example", "access-control-request-method": "POST" },
    });
    expect(Object.keys(preflight.headers).filter((n) => n.startsWith("access-control-"))).toEqual(
      [],
    );
    expect(stub.seen).toHaveLength(0);
  });
});

test.describe("leakage", () => {
  test("responses and logs never carry the internal address, headers or cookies", async () => {
    stub.control.mode = "hostile";
    const secret = "cv_session=SECRET-VALUE-9f2c";
    const replies = [
      await send({ headers: { cookie: secret }, body: pattern(2048) }),
      await send({ headers: { cookie: secret, "content-length": "0" }, body: Buffer.alloc(0) }),
      await send({ headers: { cookie: secret, "content-type": "text/html" } }),
    ];
    const everything = replies.map((r) => JSON.stringify(r.headers) + r.body).join("\n");
    expect(everything).not.toMatch(/3199|127\.0\.0\.1|internal-api|Express|x-internal/i);
    expect(replies[0]?.headers["set-cookie"]).toBeUndefined();
    expect(Object.keys(replies[0]?.headers ?? {})).not.toContain("server");
    expect(replies[0]?.headers["x-powered-by"]).toBeUndefined();
    expect(replies[0]?.headers["cache-control"]).toBe("no-store");
    expect(replies[0]?.headers["x-content-type-options"]).toBe("nosniff");

    const log = readFileSync("playwright-report/web-upload.log", "utf8");
    expect(log).not.toContain("SECRET-VALUE");
    expect(log).not.toMatch(/3199/);
  });
});
