import type { ApiEnv } from "@contextvault/config";
import type { NestExpressApplication } from "@nestjs/platform-express";

// Shared by main and the HTTP tests so both run with the same transport settings.
export function configureApp(app: NestExpressApplication, env: ApiEnv): void {
  app.disable("x-powered-by");
  // The client address comes only from the socket and this explicit hop count (0 = direct).
  app.set("trust proxy", env.TRUSTED_PROXY_HOPS);
}
