import { Redis } from "ioredis";
import { errorCause } from "./error-cause";

// Dedicated to the queue producer. Unlike a BullMQ Worker's blocking connection (which needs
// maxRetriesPerRequest: null and so queues commands forever), a command here fails at once while
// Redis is down: no offline queue, and a command that is sent gets one attempt. The dispatcher
// treats that as a failed enqueue and leaves the outbox entry untouched.
export async function connectProducer(url: string): Promise<Redis> {
  let connected = false;
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // Bounds a command sent to a Redis that stopped answering, so abandoned adds do not pile up.
    commandTimeout: 10_000,
    // Startup fails fast when Redis is unreachable; once connected, ioredis reconnects with backoff.
    retryStrategy: (attempt) => (connected ? Math.min(attempt * 200, 2000) : null),
  });
  // ioredis reconnects on its own, so errors are logged, not fatal. Messages carry host:port,
  // so only the short error label (e.g. Error:ECONNREFUSED) is logged.
  redis.on("error", (error) => {
    console.error(
      JSON.stringify({ level: "error", code: "REDIS_ERROR", cause: errorCause(error) }),
    );
  });
  redis.once("ready", () => {
    connected = true;
  });
  await redis.connect();
  return redis;
}

// QUIT needs a live connection: while Redis is unreachable it rejects, and the socket must still go.
export async function closeProducer(redis: Redis): Promise<void> {
  try {
    await redis.quit();
  } catch (error) {
    console.error(
      JSON.stringify({ level: "warn", code: "REDIS_QUIT_FAILED", cause: errorCause(error) }),
    );
    redis.disconnect();
  }
}
