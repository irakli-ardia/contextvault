import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createS3DocumentStore } from "./s3-document-store";
import { env, exists, MAX_OBJECT, read, sha256, store, trackedKey } from "./seaweed-support";
import { abortable, chunks, rejection } from "./test-support";

describe("SeaweedFS", () => {
  it.each([1, 65_536, MAX_OBJECT])(
    "stores %i bytes and reads back the same SHA-256",
    async (size) => {
      const data = randomBytes(size);
      const key = trackedKey();
      await store.put(key, chunks(data), size);
      expect(await store.head(key)).toEqual({ length: size });
      expect(sha256(await read(key))).toBe(sha256(data));
    },
  );

  it("head of a missing object is null; delete is idempotent", async () => {
    const key = trackedKey();
    expect(await store.head(key)).toBeNull();
    await store.delete(key);
    await store.put(key, chunks(Buffer.from("bye")), 3);
    await store.delete(key);
    await store.delete(key);
    expect(await store.head(key)).toBeNull();
  });

  it.each([
    ["short", 100_000, 150_000],
    ["long", 200_000, 100_000],
  ])("a %s body stores nothing", async (_name, sent, declared) => {
    const key = trackedKey();
    expect(await rejection(store.put(key, chunks(randomBytes(sent)), declared))).toMatchObject({
      code: "storage.length_mismatch",
    });
    await sleep(300);
    expect(await exists(key)).toBe(false);
  });

  it("a failing body stores nothing and surfaces its own error", async () => {
    const key = trackedKey();
    const boom = new Error("verifier said no");
    async function* failing(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 5; i++) {
        yield randomBytes(8192);
        await sleep(10);
      }
      throw boom;
    }
    expect(await rejection(store.put(key, failing(), 500_000))).toBe(boom);
    await sleep(300);
    expect(await exists(key)).toBe(false);
  });

  it("an aborted upload stores nothing", async () => {
    const key = trackedKey();
    async function* slow(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 200; i++) {
        yield randomBytes(10_000);
        await sleep(10);
      }
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    expect(
      await rejection(store.put(key, abortable(slow(), controller.signal), 2_000_000)),
    ).toMatchObject({ name: "AbortError" });
    await sleep(300);
    expect(await exists(key)).toBe(false);
  });

  it("wrong credentials are a permanent failure and store nothing", async () => {
    const bad = createS3DocumentStore(
      { ...env, S3_SECRET_ACCESS_KEY: "wrong-secret" },
      { maxBytes: MAX_OBJECT },
    );
    const key = trackedKey();
    expect(await rejection(bad.put(key, chunks(Buffer.from("x")), 1))).toMatchObject({
      code: "storage.rejected",
      retryable: false,
    });
    bad.onModuleDestroy();
    expect(await exists(key)).toBe(false);
  });

  it("an unreachable endpoint is retryable", async () => {
    const down = createS3DocumentStore(
      { ...env, S3_ENDPOINT: "http://127.0.0.1:1" },
      { maxBytes: MAX_OBJECT },
    );
    expect(await rejection(down.head(trackedKey()))).toMatchObject({
      code: "storage.unavailable",
      retryable: true,
    });
    down.onModuleDestroy();
  });

  it("the bucket is private: anonymous read, write, and delete are refused", async () => {
    const key = trackedKey();
    await store.put(key, chunks(Buffer.from("secret")), 6);
    const url = `${env.S3_ENDPOINT}/${env.S3_BUCKET}/${key}`;
    expect((await fetch(url)).status).toBe(403);
    expect((await fetch(url, { method: "PUT", body: "overwrite" })).status).toBe(403);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(403);
    expect((await read(key)).toString()).toBe("secret");
  });
});
