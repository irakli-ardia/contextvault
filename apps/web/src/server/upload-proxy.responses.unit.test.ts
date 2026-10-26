import { describe, expect, it, vi } from "vitest";
import { type Fetch, json, reading, run, source, upload } from "./upload-proxy-test-support";

describe("proxyUpload responses", () => {
  it("relays status, JSON body, request id and Retry-After, and nothing else", async () => {
    const upstream = json(
      429,
      { error: { code: "upload.busy", requestId: "api-9" } },
      {
        "x-request-id": "api-9",
        "retry-after": "1",
        "set-cookie": "cv_session=evil",
        server: "internal-api/1.0",
        "x-powered-by": "Express",
        location: "http://127.0.0.1:3001/secret",
      },
    );
    const res = await run(upload({}, source(1).stream), reading(upstream));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { code: "upload.busy", requestId: "api-9" } });
    expect(Object.fromEntries(res.headers)).toEqual({
      "cache-control": "no-store",
      "content-type": "application/json",
      "retry-after": "1",
      "x-content-type-options": "nosniff",
      "x-request-id": "api-9",
    });
  });

  it.each([
    [
      "a redirect",
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3001/x" } }),
    ],
    [
      "HTML",
      new Response("<h1>/srv/api/internal/stack</h1>", {
        status: 500,
        headers: { "content-type": "text/html" },
      }),
    ],
    ["a body without a type", new Response("oops", { status: 502 })],
  ])("replaces %s from the API with a generic 502", async (_name, upstream) => {
    const res = await run(upload({}, source(1).stream), reading(upstream));
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error: { code: "upload.upstream_error", requestId: "req-1" },
    });
    expect(`${text}${JSON.stringify([...res.headers])}`).not.toMatch(/127\.0\.0\.1|srv|location/i);
  });

  it("hides the internal address when the API cannot be reached", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = vi.fn<Fetch>(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED 127.0.0.1:3001"),
      });
    });
    const res = await run(upload({}, source(1).stream), refused);
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error: { code: "upload.upstream_unavailable", requestId: "req-1" },
    });
    expect(text + JSON.stringify(log.mock.calls)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
  });
});
