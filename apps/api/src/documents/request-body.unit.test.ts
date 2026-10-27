import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { UploadInterrupted } from "@contextvault/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestBody } from "./request-body";

afterEach(() => vi.useRealTimers());

function request() {
  const req = new IncomingMessage(new Socket());
  return req;
}
const limits = (deadline = new AbortController().signal) => ({ idleMs: 1_000, deadline });
const reason = (error: unknown) => (error instanceof UploadInterrupted ? error.reason : error);
async function drain(source: AsyncIterable<Uint8Array>) {
  const parts: number[] = [];
  for await (const chunk of source) parts.push(chunk.length);
  return parts;
}

describe("requestBody", () => {
  it("yields the chunks as they arrive and ends cleanly on a complete request", async () => {
    const req = request();
    const done = drain(requestBody(req, limits()));
    req.push(Buffer.alloc(3));
    req.push(Buffer.alloc(5));
    req.complete = true;
    req.push(null);
    expect((await done).reduce((a, b) => a + b, 0)).toBe(8);
  });

  it("fails with idle_timeout when no byte arrives for idleMs", async () => {
    vi.useFakeTimers();
    const req = request();
    const outcome = drain(requestBody(req, limits())).catch(reason);
    await vi.advanceTimersByTimeAsync(999);
    req.push(Buffer.alloc(1)); // resets the idle clock
    await vi.advanceTimersByTimeAsync(999);
    await vi.advanceTimersByTimeAsync(2);
    expect(await outcome).toBe("idle_timeout");
  });

  it("fails with deadline_exceeded when the total deadline fires, even while bytes keep coming", async () => {
    const stop = new AbortController();
    const req = request();
    const outcome = drain(requestBody(req, limits(stop.signal))).catch(reason);
    req.push(Buffer.alloc(1));
    stop.abort();
    expect(await outcome).toBe("deadline_exceeded");
  });

  it("an already expired deadline fails before reading anything", async () => {
    const req = request();
    const outcome = await drain(requestBody(req, limits(AbortSignal.abort()))).catch(reason);
    expect(outcome).toBe("deadline_exceeded");
  });

  it.each([
    ["the connection errors", (req: IncomingMessage) => req.destroy(new Error("ECONNRESET"))],
    ["the stream ends before the request is complete", (req: IncomingMessage) => req.push(null)],
  ])("fails with client_disconnected when %s", async (_name, act) => {
    const req = request();
    const outcome = drain(requestBody(req, limits())).catch(reason);
    act(req);
    expect(await outcome).toBe("client_disconnected");
  });

  it("leaves no timer or listener behind and pauses the request", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const req = request();
    const body = requestBody(req, limits(stop.signal));
    const first = body.next();
    req.push(Buffer.alloc(1));
    await first;
    await body.return(undefined);
    expect(vi.getTimerCount()).toBe(0);
    expect(req.isPaused()).toBe(true);
  });
});
