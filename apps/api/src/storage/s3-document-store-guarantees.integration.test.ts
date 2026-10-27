import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { CreateBucketCommand, DeleteBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createS3DocumentStore } from "./s3-document-store";
import { env, MAX_OBJECT, raw, read, sha256, store, trackedKey } from "./seaweed-support";
import { chunks, rejection } from "./test-support";

describe("SeaweedFS guarantees", () => {
  it("is create-only: a second put to the same key fails and keeps the first bytes", async () => {
    const key = trackedKey();
    const first = randomBytes(5000);
    await store.put(key, chunks(first), first.length);
    const second = randomBytes(7000);
    expect(await rejection(store.put(key, chunks(second), second.length))).toMatchObject({
      code: "storage.conflict",
      retryable: false,
    });
    expect(await store.head(key)).toEqual({ length: first.length });
    expect(sha256(await read(key))).toBe(sha256(first));
  });

  it("concurrent puts to one key: exactly one wins and its bytes are what is stored", async () => {
    const key = trackedKey();
    const bodies = Array.from({ length: 12 }, () => randomBytes(300_000));
    const results = await Promise.allSettled(
      bodies.map((b) => store.put(key, chunks(b), b.length)),
    );
    const winners = results.flatMap((r, i) => (r.status === "fulfilled" ? [i] : []));
    expect(winners).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "storage.conflict" });
    }
    const stored = sha256(await read(key));
    expect(bodies.filter((b) => sha256(b) === stored)).toHaveLength(1);
    expect(stored).toBe(sha256(bodies[winners[0] ?? 0] ?? Buffer.alloc(0)));
  });

  it("a failed put leaves the key free; after delete the key can be created again", async () => {
    const key = trackedKey();
    expect(await rejection(store.put(key, chunks(randomBytes(10)), 20))).toMatchObject({
      code: "storage.length_mismatch",
    });
    await sleep(200);
    await store.put(key, chunks(Buffer.from("ok")), 2);
    await store.delete(key);
    await store.put(key, chunks(Buffer.from("again")), 5);
    expect((await read(key)).toString()).toBe("again");
  });

  it("assertBucket accepts the configured bucket", async () => {
    await store.assertBucket();
  });

  it("assertBucket rejects a mistyped bucket as configuration and does not create it", async () => {
    const typo = `typo-${randomUUID()}`;
    const other = createS3DocumentStore({ ...env, S3_BUCKET: typo }, { maxBytes: MAX_OBJECT });
    const error = await rejection(other.assertBucket());
    other.onModuleDestroy();
    expect(error).toMatchObject({ code: "storage.rejected", retryable: false });
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(typo);
    const probe = await raw.send(new HeadBucketCommand({ Bucket: typo })).then(
      () => "exists",
      (e: { $metadata?: { httpStatusCode?: number } }) => e.$metadata?.httpStatusCode,
    );
    expect(probe).toBe(404);
  });

  it("assertBucket reports bad credentials as configuration and a down provider as retryable", async () => {
    const bad = createS3DocumentStore(
      { ...env, S3_SECRET_ACCESS_KEY: "wrong-secret" },
      { maxBytes: MAX_OBJECT },
    );
    const down = createS3DocumentStore(
      { ...env, S3_ENDPOINT: "http://127.0.0.1:1" },
      { maxBytes: MAX_OBJECT },
    );
    expect(await rejection(bad.assertBucket())).toMatchObject({
      code: "storage.rejected",
      retryable: false,
    });
    expect(await rejection(down.assertBucket())).toMatchObject({
      code: "storage.unavailable",
      retryable: true,
    });
    bad.onModuleDestroy();
    down.onModuleDestroy();
  });

  it("a bucket that disappears after startup is never recreated by a put", async () => {
    const Bucket = `gone-${randomUUID()}`;
    await raw.send(new CreateBucketCommand({ Bucket }));
    const other = createS3DocumentStore({ ...env, S3_BUCKET: Bucket }, { maxBytes: MAX_OBJECT });
    await other.assertBucket();
    await raw.send(new DeleteBucketCommand({ Bucket }));
    const error = await rejection(other.put(trackedKey(), chunks(Buffer.from("x")), 1));
    other.onModuleDestroy();
    expect(error).toMatchObject({ code: "storage.rejected", retryable: false });
    const probe = await raw.send(new HeadBucketCommand({ Bucket })).then(
      () => "exists",
      (e: { $metadata?: { httpStatusCode?: number } }) => e.$metadata?.httpStatusCode,
    );
    expect(probe).toBe(404);
  });
});
