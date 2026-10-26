import { describe, expect, it, vi } from "vitest";
import {
  chunkSize,
  drain,
  type Fetch,
  json,
  run,
  source,
  upload,
} from "./upload-proxy-test-support";

describe("proxyUpload streaming and cancellation", () => {
  it("reads ahead of a stalled consumer by a few chunks, not by the body", async () => {
    const chunks = 160; // 10 MiB
    const body = source(chunks);
    let release = (): void => undefined;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn<Fetch>(async (_url, init) => {
      await stalled;
      await drain(init);
      return json(201, {});
    });
    const pending = run(upload({}, body.stream, chunks * chunkSize), fetchImpl);
    for (let tick = 0; tick < 20; tick++) await new Promise((r) => setTimeout(r, 0));
    expect(body.pulled()).toBeLessThanOrEqual(8);
    release();
    expect((await pending).status).toBe(201);
    expect(body.pulled()).toBe(chunks);
  });

  it("delivers every byte exactly once and in order", async () => {
    const fetchImpl = vi.fn<Fetch>(async (_url, init) => json(201, { bytes: await drain(init) }));
    const res = await run(upload({}, source(3, 1000).stream, 3000), fetchImpl);
    expect(await res.json()).toEqual({ bytes: 3000 });
  });

  it.each([
    ["more", 2000],
    ["fewer", 500],
  ])("fails with 400 when the body carries %s bytes than declared", async (_name, actual) => {
    const fetchImpl = vi.fn<Fetch>(async (_url, init) => {
      try {
        await drain(init);
      } catch (cause) {
        throw new TypeError("fetch failed", { cause });
      }
      return json(201, {});
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await run(upload({}, source(1, actual).stream, 1000), fetchImpl);
    expect([res.status, await res.json()]).toEqual([
      400,
      { error: { code: "upload.incomplete", requestId: "req-1" } },
    ]);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ code: "upload.incomplete", requestId: "req-1" }),
    );
  });

  it("hands the client's abort signal to the upstream request, and an abort ends the call", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    const fetchImpl = vi.fn<Fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal;
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pending = run(upload({}, source(1).stream, undefined, controller.signal), fetchImpl);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect((await pending).status).toBe(502);
    expect(seen?.aborted).toBe(true);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ code: "upload.upstream_unavailable", requestId: "req-1" }),
    );
  });
});
