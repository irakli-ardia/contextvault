import type { ApiEnv } from "@contextvault/config";
import type { PasswordHasher } from "@contextvault/domain";
import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth/auth.controller";
import { authProviders } from "./auth/auth.providers";
import { AuthService } from "./auth/auth.service";
import { ErrorFilter } from "./auth/error.filter";
import { OriginGuard } from "./auth/origin.guard";
import { responseHeaders } from "./auth/response-headers.middleware";
import { SessionGuard } from "./auth/session.guard";
import { SessionCookies } from "./auth/session-cookies";
import { WorkspaceGuard } from "./auth/workspace.guard";
import { HealthController } from "./health/health.controller";
import { storageProviders } from "./storage/storage.providers";
import { WorkspacesController } from "./workspaces/workspaces.controller";

@Module({})
export class AppModule implements NestModule {
  static register(env: ApiEnv, options: { hasher?: PasswordHasher } = {}): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, WorkspacesController],
      providers: [
        ...authProviders(env, options.hasher),
        ...storageProviders,
        AuthService,
        SessionCookies,
        // Order matters: origin (CSRF) first, then identity, then workspace membership.
        { provide: APP_GUARD, useClass: OriginGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_GUARD, useClass: WorkspaceGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(responseHeaders).forRoutes({ path: "{*path}", method: RequestMethod.ALL });
  }
}
