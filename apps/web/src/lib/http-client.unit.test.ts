import { describe, expect, it, vi } from "vitest";
import { expectShape, HttpError, request } from "./http-client";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

async function failure(promise: Promise<unknown>): Promise<HttpError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof HttpError)) throw new Error("expected an HttpError");
  return error;
}

describe("request", () => {
  it("sends a same-origin JSON request with the cookie jar only", async () => {
    const send = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ ok: 1 }));
    const body = await request("/api/auth/login", {
      method: "POST",
      json: { email: "a@b.c" },
      fetch: send,
    });
    expect(body).toEqual({ ok: 1 });
    const [url, init] = send.mock.calls[0] ?? [];
    expect(url).toBe("/api/auth/login");
    expect(init).toMatchObject({
      method: "POST",
      body: '{"email":"a@b.c"}',
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
    });
    expect(Object.keys(Object(init).headers).sort()).toEqual(["accept", "content-type"]);
  });

  it.each(["https://evil.example/api/x", "//evil.example/api/x", "/api//evil.example", "/health"])(
    "refuses %s before sending anything",
    async (path) => {
      const send = vi.fn();
      await expect(request(path, { fetch: send })).rejects.toThrow("same-origin");
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("returns null for an empty 204 body", async () => {
    const body = await request("/api/auth/logout", {
      method: "POST",
      fetch: async () => new Response(null, { status: 204 }),
    });
    expect(body).toBeNull();
  });

  it("maps an API error body to code, request id and Retry-After", async () => {
    const error = await failure(
      request("/api/auth/login", {
        fetch: async () =>
          json(
            { error: { code: "auth.throttled", requestId: "r1" } },
            { status: 429, headers: { "retry-after": "7" } },
          ),
      }),
    );
    expect(error).toMatchObject({
      status: 429,
      code: "auth.throttled",
      requestId: "r1",
      retryAfterSeconds: 7,
    });
  });

  it.each([
    ["an HTML error page", () => new Response("<h1>bad gateway</h1>", { status: 502 })],
    ["an error body of the wrong shape", () => json({ message: "nope" }, { status: 500 })],
    ["a 200 that is not JSON", () => new Response("oops", { status: 200 })],
  ])("reports %s as response.invalid", async (_name, make) => {
    const error = await failure(request("/api/x", { fetch: async () => make() }));
    expect(error.code).toBe("response.invalid");
  });

  it("reports an unreachable server as network.unavailable and keeps an abort an abort", async () => {
    const down = await failure(
      request("/api/x", {
        fetch: async () => {
          throw new TypeError("Failed to fetch");
        },
      }),
    );
    expect(down).toMatchObject({ status: 0, code: "network.unavailable" });

    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException("aborted", "AbortError");
    await expect(
      request("/api/x", {
        signal: controller.signal,
        fetch: async () => {
          throw abort;
        },
      }),
    ).rejects.toBe(abort);
  });
});

describe("expectShape", () => {
  it("returns the parsed value or fails as response.invalid", () => {
    expect(expectShape(1, (v) => (v === 1 ? "one" : null))).toBe("one");
    expect(() => expectShape(2, () => null)).toThrow(HttpError);
  });
});
