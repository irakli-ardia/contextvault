import { MAX_UPLOAD_BYTES } from "@contextvault/contracts";
import { expect, test } from "@playwright/test";
import { pattern, raw, send, sha256, uploadPath, workspace } from "./upload-client";
import { createStub } from "./upload-stub";

const stub = createStub(3199);
test.beforeAll(() => stub.start());
test.afterAll(() => stub.stop());
test.beforeEach(() => stub.reset());

const MiB = 1024 * 1024;

test.describe("size and framing", () => {
  test("streams a file of exactly the maximum size, byte for byte", async () => {
    const body = pattern(MAX_UPLOAD_BYTES);
    const reply = await send({ body });
    expect([reply.status, JSON.parse(reply.body)]).toEqual([201, { ok: true }]);
    const [seen] = stub.seen;
    expect(stub.seen).toHaveLength(1);
    expect(seen?.url).toBe(`/workspaces/${workspace}/uploads`);
    expect(seen?.bytes).toBe(MAX_UPLOAD_BYTES);
    expect(seen?.sha256).toBe(sha256(body));
    // Framed by length, never chunked: the API can rely on Content-Length.
    expect(seen?.headers["content-length"]).toBe(String(MAX_UPLOAD_BYTES));
    expect(seen?.headers["transfer-encoding"]).toBeUndefined();
  });

  test("refuses a declared size one byte over, without contacting the API", async () => {
    const reply = await send({ body: pattern(MAX_UPLOAD_BYTES + 1) });
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body).error.code).toBe("upload.too_large");
    expect(stub.seen).toHaveLength(0);
  });

  test("refuses a missing Content-Length (chunked) with 411", async () => {
    const reply = await send({ headers: { "content-length": undefined } });
    expect([reply.status, JSON.parse(reply.body).error.code]).toEqual([
      411,
      "upload.length_required",
    ]);
    expect(stub.seen).toHaveLength(0);
  });

  test("refuses invalid, contradictory and smuggling-shaped framing", async () => {
    const head = (extra: string[], body = "hello") =>
      [
        `POST ${uploadPath} HTTP/1.1`,
        "Host: 127.0.0.1:3101",
        "Origin: http://127.0.0.1:3101",
        "Content-Type: application/pdf",
        "X-Filename: a.pdf",
        ...extra,
        "Connection: close",
        "",
        body,
      ].join("\r\n");
    const cases: [string, string[], number][] = [
      ["letters", ["Content-Length: abc"], 400],
      ["negative", ["Content-Length: -1"], 400],
      ["exponent", ["Content-Length: 1e3"], 400],
      ["hex", ["Content-Length: 0x10"], 400],
      ["plus sign", ["Content-Length: +5"], 400],
      ["leading zero", ["Content-Length: 05"], 400],
      ["zero", ["Content-Length: 0"], 400],
      ["two lengths", ["Content-Length: 5", "Content-Length: 6"], 400],
      ["length and chunked", ["Content-Length: 5", "Transfer-Encoding: chunked"], 400],
      ["chunked only", ["Transfer-Encoding: chunked"], 411],
    ];
    for (const [name, extra, status] of cases) {
      const chunked = extra.some((h) => h.startsWith("Transfer-Encoding"));
      const reply = await raw(head(extra, chunked ? "5\r\nhello\r\n0\r\n\r\n" : "hello"));
      expect([name, reply.status]).toEqual([name, status]);
    }
    expect(stub.seen).toHaveLength(0);
  });

  test("a body shorter than declared, then a closed connection, reaches the API as an abort", async () => {
    stub.control.mode = "slow";
    await send({ body: pattern(4 * MiB), abortAfter: MiB });
    await expect.poll(() => stub.seen[0]?.aborted).toBe(true);
    expect(stub.seen[0]?.finished).toBe(false);
    // The failed upload leaves the transport usable.
    stub.reset();
    expect((await send()).status).toBe(201);
  });
});

test.describe("streaming", () => {
  test("a slow consumer paces the client; the body is not absorbed first", async () => {
    // 10 MiB at 64 KiB per 15 ms is about 2.4 s for the consumer. A buffering proxy lets the
    // client finish in milliseconds (measured: 37 ms of 13.5 s for a rewrite); a streaming one
    // keeps it within the socket buffers of the consumer. 20 % leaves room for large kernel
    // buffers on other platforms and still tells the two apart by two orders of magnitude.
    stub.control.mode = "slow";
    const body = pattern(MAX_UPLOAD_BYTES);
    const reply = await send({ body });
    expect(reply.status).toBe(201);
    const [seen] = stub.seen;
    expect(seen?.sha256).toBe(sha256(body));
    const consumerMs = (seen?.endedAt ?? 0) - (seen?.startedAt ?? 0);
    console.log(
      `streaming: consumer ${consumerMs} ms, client finished writing at ${reply.wroteAllAfter} ms`,
    );
    expect(consumerMs).toBeGreaterThan(1500);
    expect(reply.wroteAllAfter).toBeGreaterThan(consumerMs * 0.2);
    // Streaming, not store-and-forward: the first byte arrived long before the client finished.
    expect((seen?.firstByteAt ?? 0) - (seen?.startedAt ?? 0)).toBeLessThan(500);
  });

  test("cancelling mid-upload aborts the upstream request", async () => {
    stub.control.mode = "slow";
    await send({ body: pattern(MAX_UPLOAD_BYTES), abortAfter: 3 * MiB });
    await expect.poll(() => stub.seen[0]?.aborted).toBe(true);
    expect(stub.seen[0]?.bytes).toBeLessThan(MAX_UPLOAD_BYTES);
  });
});

test.describe("upstream behaviour", () => {
  test("relays an API error body and status", async () => {
    stub.control.mode = "error500";
    const reply = await send();
    expect([reply.status, JSON.parse(reply.body)]).toEqual([
      500,
      { error: { code: "internal", requestId: "stub-1" } },
    ]);
    expect(reply.headers["x-request-id"]).toBe("stub-1");
  });

  test("an early rejection from the API reaches the client", async () => {
    stub.control.mode = "early401";
    const reply = await send({ body: pattern(64 * 1024) });
    expect([reply.status, JSON.parse(reply.body).error.code]).toEqual([
      401,
      "auth.unauthenticated",
    ]);
  });

  for (const mode of ["redirect", "html", "destroy"] as const) {
    test(`a ${mode} answer becomes a generic 502 without internal detail`, async () => {
      stub.control.mode = mode;
      const reply = await send({ body: pattern(256 * 1024) });
      expect(reply.status).toBe(502);
      const everything = JSON.stringify(reply.headers) + reply.body;
      expect(everything).not.toMatch(/3199|3001|127\.0\.0\.1|\/srv|location/i);
      expect(JSON.parse(reply.body).error.code).toMatch(/^upload\.upstream_/);
    });
  }

  test("an unreachable API becomes a generic 502, and recovery needs no restart", async () => {
    await stub.stop();
    const down = await send();
    expect(down.status).toBe(502);
    expect(JSON.parse(down.body).error.code).toBe("upload.upstream_unavailable");
    expect(down.body + JSON.stringify(down.headers)).not.toMatch(/3199|ECONNREFUSED|127\.0\.0\.1/);
    await stub.start();
    expect((await send()).status).toBe(201);
  });
});
