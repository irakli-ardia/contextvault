import type { IncomingMessage } from "node:http";
import { UploadInterrupted } from "@contextvault/domain";

export interface BodyLimits {
  readonly idleMs: number;
  /** Fires at the total deadline of the whole upload. */
  readonly deadline: AbortSignal;
}

const noop = () => undefined;

/**
 * The request body as the use case consumes it: chunks as they arrive, failing with a typed
 * `UploadInterrupted` when the client goes away, stalls longer than `idleMs`, or the total
 * deadline passes. The request is never destroyed here: that would reset the socket and with it
 * the response; the route sends `Connection: close` and Node ends the connection after replying.
 */
export async function* requestBody(
  req: IncomingMessage,
  limits: BodyLimits,
): AsyncGenerator<Uint8Array> {
  // An aborted request errors; without a listener that would be thrown as an uncaught exception.
  req.on("error", noop);
  const chunks = req[Symbol.asyncIterator]();
  const onAbort = () => expire(new UploadInterrupted("deadline_exceeded"));
  let expire: (error: UploadInterrupted) => void = noop;
  const deadline = new Promise<never>((_resolve, reject) => {
    expire = reject;
  });
  deadline.catch(noop);
  if (limits.deadline.aborted) onAbort();
  else limits.deadline.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new UploadInterrupted("idle_timeout")), limits.idleMs);
      });
      idle.catch(noop);
      const next = chunks.next().catch((): never => {
        throw new UploadInterrupted("client_disconnected");
      });
      next.catch(noop);
      let step: IteratorResult<unknown>;
      try {
        step = await Promise.race([next, idle, deadline]);
      } finally {
        clearTimeout(timer);
      }
      if (step.done) {
        // The stream ended without delivering the whole request: the client left mid-body.
        if (!req.complete) throw new UploadInterrupted("client_disconnected");
        return;
      }
      if (step.value instanceof Uint8Array) yield step.value;
    }
  } finally {
    limits.deadline.removeEventListener("abort", onAbort);
    req.pause();
  }
}
