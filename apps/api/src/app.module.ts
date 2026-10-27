import type { ApiEnv } from "@contextvault/config";
import type { DocumentStore, PasswordHasher } from "@contextvault/domain";
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
import { closeConnection } from "./documents/close-connection.middleware";
import { documentProviders, type UploadTimeouts } from "./documents/documents.providers";
import { UploadsController } from "./documents/uploads.controller";
import { HealthController } from "./health/health.controller";
import { storageProviders } from "./storage/storage.providers";
import { WorkspacesController } from "./workspaces/workspaces.controller";

@Module({})
export class AppModule implements NestModule {
  static register(
    env: ApiEnv,
    options: {
      hasher?: PasswordHasher;
      store?: DocumentStore;
      uploadTimeouts?: UploadTimeouts;
    } = {},
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, WorkspacesController, UploadsController],
      providers: [
        ...authProviders(env, options.hasher),
        ...storageProviders(options.store),
        ...documentProviders(options.uploadTimeouts),
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
    consumer
      .apply(closeConnection)
      .forRoutes({ path: "workspaces/:workspaceId/uploads", method: RequestMethod.POST });
  }
}
