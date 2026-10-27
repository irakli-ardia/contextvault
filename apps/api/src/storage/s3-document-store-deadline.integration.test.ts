import { describe, expect, it } from "vitest";
import { chunks, newKey, rejection, setup } from "./test-support";

// A provider that takes the whole body and then never answers: the caller's deadline is the only
// way out, and the outcome is unknown (the object may or may not exist).
const silent = (request: import("node:http").IncomingMessage) => {
  request.resume();
};

describe("put with a caller deadline", () => {
  it("aborts a request that is waiting for the provider's answer", async () => {
    const { store } = await setup(silent);
    const stop = new AbortController();
    const pending = rejection(
      store.put(newKey(), chunks(Buffer.alloc(1000, 1)), 1000, { signal: stop.signal }),
    );
    setTimeout(() => stop.abort(), 100);
    expect(await pending).toMatchObject({ code: "storage.unavailable", retryable: true });
  });

  it("fails at once when the deadline has already passed", async () => {
    const { store } = await setup(silent);
    const error = await rejection(
      store.put(newKey(), chunks(Buffer.alloc(1000, 1)), 1000, { signal: AbortSignal.abort() }),
    );
    expect(error).toMatchObject({ code: "storage.unavailable" });
  });
});
