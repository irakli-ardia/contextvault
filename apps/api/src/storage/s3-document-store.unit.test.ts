import { randomBytes } from "node:crypto";
import { addAbortSignal, PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { SECRET } from "./fake-s3";
import { abortable, chunks, codeOf, MAX, newKey, ok, rejection, setup } from "./test-support";

// An AbortSignal that fires after `ms`, the way a request pipeline would cancel the body.
const controllerSignal = (ms: number): AbortSignal => AbortSignal.timeout(ms);

describe("put", () => {
  it("streams exactly the declared bytes to a path-style key, signed, with no checksum trailer", async () => {
    const { fake, store } = await setup(ok);
    const data = randomBytes(300_000);
    const key = newKey();
    await store.put(key, chunks(data), data.length);
    const [seen] = fake.seen;
    expect(seen?.method).toBe("PUT");
    expect(seen?.url).toBe(`/private-bucket/${key}?x-id=PutObject`);
    expect(seen?.headers["content-length"]).toBe(String(data.length));
    expect(seen?.headers["content-encoding"]).toBeUndefined();
    expect(seen?.headers["x-amz-trailer"]).toBeUndefined();
    expect(seen?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=fake-access-key\//);
    expect(seen?.headers.authorization).not.toContain(SECRET);
    expect(seen?.headers["x-amz-acl"]).toBeUndefined();
    expect(seen?.body.equals(data)).toBe(true);
  });

  it("keeps the key free of anything but ids", async () => {
    const { fake, store } = await setup(ok);
    await store.put(newKey(), chunks(Buffer.from("x")), 1);
    expect(fake.seen[0]?.url?.split("?")[0]).toMatch(
      /^\/private-bucket\/ws\/[0-9a-f-]{36}\/doc\/[0-9a-f-]{36}\/v\/[0-9a-f-]{36}$/,
    );
  });

  it("pulls from the source only as fast as the provider reads (backpressure)", async () => {
    let produced = 0;
    const total = 48 * 1024 * 1024;
    async function* source(): AsyncGenerator<Uint8Array> {
      while (produced < total) {
        produced += 65_536;
        yield Buffer.alloc(65_536);
      }
    }
    const { store } = await setup((request) => {
      request.pause(); // never reads: the socket buffers fill and the stream must stall
    });
    const pending = store.put(newKey(), abortable(source(), AbortSignal.timeout(600)), total);
    await rejection(pending);
    expect(produced).toBeLessThan(total / 2);
  });

  it.each([
    ["short", 100_000, 150_000],
    ["long", 200_000, 100_000],
  ])(
    "fails a %s body with a length mismatch and the request never completes",
    async (_n, sent, declared) => {
      const { fake, store } = await setup(ok);
      const error = await rejection(store.put(newKey(), chunks(randomBytes(sent)), declared));
      expect(codeOf(error)).toBe("storage.length_mismatch");
      expect(error).toMatchObject({ retryable: false });
      await sleep(100);
      expect(fake.seen.every((s) => !s.complete || s.body.length === declared)).toBe(true);
      expect(fake.seen.some((s) => s.complete && s.body.length === sent && sent !== declared)).toBe(
        false,
      );
    },
  );

  it.each([0, -1, 1.5, Number.NaN, MAX + 1])("rejects length %s before any request", async (n) => {
    const { fake, store } = await setup(ok);
    const error = await rejection(store.put(newKey(), chunks(Buffer.from("x")), n));
    expect(codeOf(error)).toBe("storage.invalid_length");
    expect(fake.seen).toHaveLength(0);
  });

  it("rejects a forged key before any request", async () => {
    const { fake, store } = await setup(ok);
    // @ts-expect-error a plain string is not a StorageKey; the adapter must still refuse it
    const attempt = store.put("../../etc/passwd", chunks(Buffer.from("x")), 1);
    expect(codeOf(await rejection(attempt))).toBe("storage.invalid_key");
    expect(fake.seen).toHaveLength(0);
  });

  it("surfaces the body's own error and leaves the request incomplete", async () => {
    const { fake, store } = await setup(ok);
    const boom = new Error("verifier said no");
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield Buffer.alloc(1000);
      await sleep(20);
      throw boom;
    }
    expect(await rejection(store.put(newKey(), failing(), 5000))).toBe(boom);
    await sleep(100);
    expect(fake.seen.every((s) => !s.complete)).toBe(true);
  });

  it("stops reading and aborts the request when the caller cancels the body", async () => {
    let produced = 0;
    async function* slow(): AsyncGenerator<Uint8Array> {
      while (true) {
        produced += 1;
        yield Buffer.alloc(1000);
        await sleep(10);
      }
    }
    const { fake, store } = await setup(ok);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const error = await rejection(
      store.put(newKey(), abortable(slow(), controller.signal), 10_000_000),
    );
    expect(error).toMatchObject({ name: "AbortError" });
    await sleep(50); // one chunk may already be in flight
    const after = produced;
    await sleep(100);
    expect(produced).toBe(after);
    expect(fake.seen.every((s) => !s.complete)).toBe(true);
  });

  it("cancelled before the first byte: rejects at once, sends no complete request, releases the source", async () => {
    const body = addAbortSignal(controllerSignal(30), new PassThrough());
    const { fake, store } = await setup(ok);
    const started = Date.now();
    const error = await rejection(store.put(newKey(), body, 100));
    expect(error).toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(body.destroyed).toBe(true);
    expect(fake.seen.every((s) => !s.complete)).toBe(true);
  });

  it("a source that never yields is bounded by the put deadline", async () => {
    const body = new PassThrough();
    const { store } = await setup(ok, { putTimeoutMs: 300 });
    const started = Date.now();
    const error = await rejection(store.put(newKey(), body, 100));
    expect(error).toMatchObject({ code: "storage.unavailable", retryable: true });
    expect(Date.now() - started).toBeLessThan(2000);
    await sleep(50); // pipeline tears the chain down on the next ticks
    expect(body.destroyed).toBe(true);
  });

  it("a provider that stops reading is bounded by the put deadline, and the source is released", async () => {
    let produced = 0;
    let closed = false;
    async function* endless(): AsyncGenerator<Uint8Array> {
      try {
        while (true) {
          produced += 65_536;
          yield Buffer.alloc(65_536);
        }
      } finally {
        closed = true;
      }
    }
    const { store } = await setup((request) => request.pause(), { putTimeoutMs: 400 });
    const started = Date.now();
    const error = await rejection(store.put(newKey(), endless(), MAX));
    expect(error).toMatchObject({ code: "storage.unavailable", retryable: true });
    expect(Date.now() - started).toBeLessThan(2000);
    await sleep(50);
    expect(closed).toBe(true);
    const after = produced;
    await sleep(100);
    expect(produced).toBe(after);
  });

  it("creates only: sends If-None-Match so an existing key is never replaced", async () => {
    const { fake, store } = await setup(ok);
    await store.put(newKey(), chunks(Buffer.from("x")), 1);
    expect(fake.seen[0]?.headers["if-none-match"]).toBe("*");
  });

  it("gives up after the put deadline as a retryable storage failure", async () => {
    const { store } = await setup(() => {}, { putTimeoutMs: 150 });
    const error = await rejection(store.put(newKey(), chunks(Buffer.from("x")), 1));
    expect(error).toMatchObject({ code: "storage.unavailable", retryable: true });
  });
});
