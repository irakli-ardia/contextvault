import { EnvError, loadWorkerEnv } from "@contextvault/config";
import { Redis } from "ioredis";
import { fail, installProcessGuards } from "./process-guards";

// No queues or processors yet; the worker only proves its runtime wiring.
async function bootstrap(): Promise<void> {
  const env = loadWorkerEnv();
  // BullMQ requires maxRetriesPerRequest: null on blocking connections.
  // Startup fails fast when Redis is unreachable; once connected, ioredis reconnects with backoff.
  let connected = false;
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => (connected ? Math.min(attempt * 200, 2000) : null),
  });
  // ioredis reconnects on its own, so errors are logged, not fatal. Messages carry host:port,
  // so only the short error code (e.g. ECONNREFUSED) is logged.
  redis.on("error", (error) => {
    const code = "code" in error && typeof error.code === "string" ? error.code : "";
    const cause = /^[A-Z_]{1,40}$/.test(code) ? code : undefined;
    console.error(JSON.stringify({ level: "error", code: "REDIS_ERROR", cause }));
  });
  redis.once("ready", () => {
    connected = true;
  });
  await redis.ping();

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    redis.quit().then(
      () => process.exit(0),
      () => fail("SHUTDOWN_FAILED"),
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  console.info(JSON.stringify({ level: "info", msg: "worker ready" }));
}

installProcessGuards();
bootstrap().catch((error: unknown) => {
  if (error instanceof EnvError) console.error(error.message);
  fail("BOOTSTRAP_FAILED");
});
