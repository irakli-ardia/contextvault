import { MAX_UPLOAD_BYTES } from "@contextvault/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  chunkSize,
  type Fetch,
  id,
  reading,
  run,
  source,
  upload,
  upstreamOrigin,
} from "./upload-proxy-test-support";

describe("proxyUpload requests", () => {
  it("sends one POST to the fixed origin and a path built from the validated id", async () => {
    const fetchImpl = reading();
    const request = upload({}, source(1).stream);
    expect((await run(request, fetchImpl)).status).toBe(201);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url instanceof URL && url.href).toBe(`${upstreamOrigin}/workspaces/${id}/uploads`);
    expect(init).toMatchObject({ method: "POST", redirect: "manual", duplex: "half" });
    expect(init?.signal).toBe(request.signal);
  });

  it("forwards only the allowlist; Cookie and Origin pass unchanged, absent stays absent", async () => {
    const fetchImpl = reading();
    const hostile = {
      cookie: "cv_session=abc; other=1",
      origin: "http://127.0.0.1:3100",
      host: "evil.example",
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
      forwarded: "for=203.0.113.9",
      "x-real-ip": "203.0.113.9",
      authorization: "Bearer stolen",
      "x-request-id": "forged",
      "content-type": "Text/Plain; charset=utf-8",
      "x-filename": "%E1%83%90.txt",
    };
    await run(upload(hostile, source(1).stream), fetchImpl);
    const sent = Object.fromEntries(new Headers(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.headers));
    expect(sent).toEqual({
      accept: "application/json",
      "content-type": "text/plain",
      "content-length": String(chunkSize),
      "x-filename": "%E1%83%90.txt",
      cookie: "cv_session=abc; other=1",
      origin: "http://127.0.0.1:3100",
    });

    const bare = reading();
    await run(upload({}, source(1).stream), bare);
    const names = [...new Headers(vi.mocked(bare).mock.calls[0]?.[1]?.headers).keys()];
    expect(names).not.toContain("cookie");
    expect(names).not.toContain("origin");
  });

  it.each([
    "not-a-uuid",
    "..",
    "../../admin",
    `${id}/../x`,
    `${id}?x=1`,
    `${id.toUpperCase()}`,
    "",
    "http://evil.example",
  ])("answers 404 for workspace id %j without contacting the API", async (bad) => {
    const fetchImpl = vi.fn<Fetch>();
    const res = await run(upload({}, source(1).stream), fetchImpl, bad);
    expect([res.status, await res.json()]).toEqual([
      404,
      { error: { code: "not_found", requestId: "req-1" } },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [{ "content-length": String(MAX_UPLOAD_BYTES + 1) }, 413, "upload.too_large"],
    [{ "content-length": "abc" }, 400, "upload.invalid_length"],
    [{ "content-length": "0" }, 400, "upload.empty"],
    [{ "content-type": "multipart/form-data" }, 415, "upload.unsupported_type"],
    [{ "x-filename": "%00" }, 400, "upload.invalid_name"],
  ])("refuses %j with %i %s before any upstream call", async (headers, status, code) => {
    const fetchImpl = vi.fn<Fetch>();
    const res = await run(upload(headers, source(1).stream), fetchImpl);
    expect([res.status, await res.json()]).toEqual([
      status,
      { error: { code, requestId: "req-1" } },
    ]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
