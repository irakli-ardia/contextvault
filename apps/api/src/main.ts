import "reflect-metadata";
import { assertArgon2Runtime } from "@contextvault/auth";
import { EnvError, loadApiEnv } from "@contextvault/config";
import { type Persistence, PrivilegeCheckFailed } from "@contextvault/db";
import { StorageError } from "@contextvault/domain";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { PERSISTENCE } from "./auth/tokens";
import { configureApp } from "./configure-app";
import { fail, installProcessGuards } from "./process-guards";
import type { S3DocumentStore } from "./storage/s3-document-store";
import { DOCUMENT_STORE } from "./storage/tokens";

async function bootstrap(): Promise<void> {
  const env = loadApiEnv();
  // Fail closed before serving: a runtime without a correct Argon2id cannot verify passwords.
  await assertArgon2Runtime().catch(() => fail("ARGON2_UNAVAILABLE"));
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env));
  configureApp(app, env);
  // SIGTERM/SIGINT close the HTTP server, then the process exits with the signal.
  app.enableShutdownHooks();
  // Refuse a database role that row-level security does not bind (superuser, BYPASSRLS, owner).
  await app.get<Persistence>(PERSISTENCE).assertLeastPrivilege();
  // Fail closed on a mistyped or inaccessible bucket; the API never creates one. Once per start.
  await app.get<S3DocumentStore>(DOCUMENT_STORE).assertBucket();
  await app.listen(env.API_PORT, env.API_HOST);
}

installProcessGuards();
bootstrap().catch((error: unknown) => {
  // Env errors name variables only, so they are safe to show; anything else is code-only.
  if (error instanceof EnvError) console.error(error.message);
  if (error instanceof PrivilegeCheckFailed) fail("PRIVILEGE_CHECK_FAILED");
  // Codes only: the bucket name and endpoint stay out of logs. Rejected means fix the
  // configuration; unavailable means the provider may simply be down.
  if (error instanceof StorageError) {
    fail(error.retryable ? "STORAGE_UNAVAILABLE" : "STORAGE_MISCONFIGURED");
  }
  fail("BOOTSTRAP_FAILED");
});
