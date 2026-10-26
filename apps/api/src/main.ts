import "reflect-metadata";
import { EnvError, loadApiEnv } from "@contextvault/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { fail, installProcessGuards } from "./process-guards";

async function bootstrap(): Promise<void> {
  const env = loadApiEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.disable("x-powered-by");
  // SIGTERM/SIGINT close the HTTP server, then the process exits with the signal.
  app.enableShutdownHooks();
  await app.listen(env.API_PORT);
}

installProcessGuards();
bootstrap().catch((error: unknown) => {
  // Env errors name variables only, so they are safe to show; anything else is code-only.
  if (error instanceof EnvError) console.error(error.message);
  fail("BOOTSTRAP_FAILED");
});
