import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createS3DocumentStore } from "./s3-document-store";
import { env, exists, store, trackedKey } from "./seaweed-support";
import { chunks, rejection } from "./test-support";

// The upload use case withholds the final declared byte until the whole body is verified, and
// treats "the put failed before that" as "no object". These pin the provider side of that premise
// at the boundary: one byte short of the declared length, however the body stops.
const SIZE = 300_000;
const almost = () => randomBytes(SIZE - 1);
const settled = async (key: ReturnType<typeof trackedKey>) => {
  await sleep(400); // a late commit would show by now
  return exists(key);
};

describe("SeaweedFS: a body one byte short of the declared length", () => {
  it("that fails leaves no object", async () => {
    const key = trackedKey();
    const boom = new Error("verdict");
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield* chunks(almost());
      throw boom;
    }
    expect(await rejection(store.put(key, failing(), SIZE))).toBe(boom);
    expect(await settled(key)).toBe(false);
  });

  it("that ends early leaves no object", async () => {
    const key = trackedKey();
    expect(await rejection(store.put(key, chunks(almost()), SIZE))).toMatchObject({
      code: "storage.length_mismatch",
    });
    expect(await settled(key)).toBe(false);
  });

  it("that stalls until the put times out leaves no object, and no byte arrives later", async () => {
    const key = trackedKey();
    const slow = createS3DocumentStore(env, { maxBytes: 1_000_000, putTimeoutMs: 300 });
    async function* stalls(): AsyncGenerator<Uint8Array> {
      yield* chunks(almost());
      await sleep(900);
      yield Buffer.from([1]); // the final byte, delivered after the timeout
    }
    expect(await rejection(slow.put(key, stalls(), SIZE))).toMatchObject({
      code: "storage.unavailable",
    });
    expect(await settled(key)).toBe(false);
    slow.onModuleDestroy();
  });
});
