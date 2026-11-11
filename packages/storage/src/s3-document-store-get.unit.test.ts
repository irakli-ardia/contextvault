import { describe, expect, it } from "vitest";
import { SECRET } from "./testing/fake-s3";
import { codeOf, newKey, rejection, setup, status } from "./testing/test-support";

const bytes = Buffer.from("hello object");
const serve =
  (body: Buffer): Parameters<typeof setup>[0] =>
  (request, response) => {
    request.resume();
    response.writeHead(200, { "content-length": body.length }).end(body);
  };

describe("S3 DocumentStore.get", () => {
  it("returns the whole object", async () => {
    const { store, fake } = await setup(serve(bytes));
    const got = await store.get(newKey(), { maxBytes: 1024 });
    expect(Buffer.from(got ?? []).equals(bytes)).toBe(true);
    expect(fake.seen[0]?.method).toBe("GET");
  });

  it("returns null for a missing object", async () => {
    const { store } = await setup(status(404));
    expect(await store.get(newKey(), { maxBytes: 1024 })).toBeNull();
  });

  it("refuses an object over the limit by its declared length", async () => {
    const { store } = await setup(serve(bytes));
    const error = await rejection(store.get(newKey(), { maxBytes: bytes.length - 1 }));
    expect(codeOf(error)).toBe("storage.too_large");
    expect(String(error)).not.toContain(SECRET);
  });

  it("refuses a forged key and a bad limit before any request", async () => {
    const { store, fake } = await setup(serve(bytes));
    // @ts-expect-error a plain string is not a StorageKey; the adapter must still refuse it
    const forged = store.get("../x", { maxBytes: 1 });
    expect(codeOf(await rejection(forged))).toBe("storage.invalid_key");
    expect(codeOf(await rejection(store.get(newKey(), { maxBytes: 0 })))).toBe(
      "storage.invalid_length",
    );
    expect(fake.seen).toHaveLength(0);
  });

  it("maps a provider failure to a retryable unavailable error", async () => {
    const { store } = await setup(status(503));
    const error = await rejection(store.get(newKey(), { maxBytes: 1024 }));
    expect(codeOf(error)).toBe("storage.unavailable");
  });

  it("rejects when the caller aborts", async () => {
    const { store } = await setup((request) => request.resume());
    const controller = new AbortController();
    const pending = rejection(store.get(newKey(), { maxBytes: 1024, signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    expect(codeOf(await pending)).toBe("storage.unavailable");
  });
});
