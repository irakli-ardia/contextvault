import { StorageError } from "@contextvault/domain";
import { describe, expect, it } from "vitest";
import { SECRET } from "./fake-s3";
import { chunks, codeOf, newKey, ok, rejection, setup, status } from "./test-support";

describe("failures", () => {
  it.each([
    [500, "storage.unavailable", true],
    [503, "storage.unavailable", true],
    [429, "storage.unavailable", true],
    [412, "storage.conflict", false],
    [403, "storage.rejected", false],
    [404, "storage.rejected", false],
    [400, "storage.rejected", false],
  ])("maps provider status %s to %s (retryable %s)", async (code, expected, retryable) => {
    const { store } = await setup(status(code));
    const error = await rejection(store.put(newKey(), chunks(Buffer.from("x")), 1));
    expect(error).toMatchObject({ code: expected, retryable });
  });

  it("treats an unreachable provider as retryable", async () => {
    const { fake, store } = await setup(ok);
    await fake.close();
    const error = await rejection(store.head(newKey()));
    expect(error).toMatchObject({ code: "storage.unavailable", retryable: true });
  });

  it("leaks no provider text, endpoint, bucket, key, or secret in any error", async () => {
    const { fake, store } = await setup(status(403));
    const key = newKey();
    const errors = [
      await rejection(store.put(key, chunks(Buffer.from("x")), 1)),
      await rejection(store.head(key)),
      await rejection(store.delete(key)),
      await rejection(store.put(key, chunks(Buffer.from("x")), 5)),
    ];
    for (const error of errors) {
      const text = JSON.stringify(error, Object.getOwnPropertyNames(error));
      for (const secret of [
        SECRET,
        "fake-access-key",
        "private-bucket",
        fake.env.S3_ENDPOINT,
        key,
      ]) {
        expect(text).not.toContain(secret);
      }
      expect(error).toBeInstanceOf(StorageError);
      expect(error instanceof Error && "cause" in error).toBe(false);
    }
  });
});

describe("head and delete", () => {
  it("head returns the stored length, or null when the object is missing", async () => {
    const present = await setup((request, response) => {
      request.resume();
      response.writeHead(200, { "content-length": "42" }).end();
    });
    expect(await present.store.head(newKey())).toEqual({ length: 42 });
    const missing = await setup(status(404));
    expect(await missing.store.head(newKey())).toBeNull();
  });

  it("delete is idempotent: success, missing, and repeated calls all resolve", async () => {
    let calls = 0;
    const { fake, store } = await setup((request, response) => {
      request.resume();
      calls += 1;
      if (calls === 1) response.writeHead(204).end();
      else response.writeHead(404).end();
    });
    const key = newKey();
    await store.delete(key);
    await store.delete(key);
    expect(fake.seen.map((s) => s.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("delete reports a transient failure as retryable", async () => {
    const { store } = await setup(status(503));
    expect(await rejection(store.delete(newKey()))).toMatchObject({ retryable: true });
  });

  it("a refused delete is not hidden as success", async () => {
    const { store } = await setup(status(403));
    expect(codeOf(await rejection(store.delete(newKey())))).toBe("storage.rejected");
  });
});

describe("assertBucket", () => {
  it("passes for an existing bucket with one HEAD request and sends nothing else", async () => {
    const { fake, store } = await setup((request, response) => {
      request.resume();
      response.writeHead(200).end();
    });
    await store.assertBucket();
    expect(fake.seen.map((s) => `${s.method} ${s.url}`)).toEqual(["HEAD /private-bucket/"]);
  });

  it.each([
    [404, "storage.rejected", false],
    [403, "storage.rejected", false],
    [503, "storage.unavailable", true],
  ])(
    "maps provider status %s to %s (retryable %s) and never creates the bucket",
    async (code, expected, retryable) => {
      const { fake, store } = await setup(status(code));
      const error = await rejection(store.assertBucket());
      expect(error).toMatchObject({ code: expected, retryable });
      expect(fake.seen.every((s) => s.method === "HEAD")).toBe(true);
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(
        "private-bucket",
      );
    },
  );

  it("treats an unreachable provider as retryable", async () => {
    const { fake, store } = await setup(ok);
    await fake.close();
    expect(await rejection(store.assertBucket())).toMatchObject({ retryable: true });
  });
});
