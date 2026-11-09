import { Redis } from "ioredis";
import { errorCause } from "../error-cause";
import { settledWithin } from "./consumer-shutdown";

// Dedicated to the queue consumer. BullMQ's blocking commands need maxRetriesPerRequest: null and
// the offline queue, so a command waits out an outage instead of failing. Startup still fails
// fast when Redis is unreachable; once connected, ioredis reconnects with backoff. Closing goes
// through `closeConsumer`, which quits within a bound and then disconnects.
export async function connectConsumer(url: string): Promise<Redis> {
  let connected = false;
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => (connected ? Math.min(attempt * 200, 2000) : null),
  });
  redis.on("error", (error) => {
    console.error(
      JSON.stringify({ level: "error", code: "REDIS_ERROR", cause: errorCause(error) }),
    );
  });
  redis.once("ready", () => {
    connected = true;
  });
  try {
    await redis.connect();
  } catch (error) {
    redis.disconnect();
    throw error;
  }
  return redis;
}

// The connection only seeds BullMQ's own (the worker duplicates it), so nothing here is worth
// waiting for. QUIT needs a live socket and, with the offline queue, waits for one forever while
// Redis is down: bound it, then drop the socket.
export async function closeConsumer(
  redis: Pick<Redis, "quit" | "disconnect">,
  timeoutMs: number,
): Promise<void> {
  await settledWithin(redis.quit(), timeoutMs);
  redis.disconnect();
}
