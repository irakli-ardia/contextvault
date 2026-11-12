import { createAnswerer, createEmbedder } from "@contextvault/ai";
import type { ApiEnv } from "@contextvault/config";
import type { DocumentStore, Embedder, PasswordHasher } from "@contextvault/domain";
import type { Answerer } from "@contextvault/domain/answers";
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
import { OriginGuard } from "./auth/origin.guard";
import { SessionGuard } from "./auth/session.guard";
import { SessionCookies } from "./auth/session-cookies";
import { WorkspaceGuard } from "./auth/workspace.guard";
import { documentProviders, type UploadTimeouts } from "./documents/documents.providers";
import { AnswersController } from "./documents/http/answers.controller";
import { closeConnection } from "./documents/http/close-connection.middleware";
import { DocumentsController } from "./documents/http/documents.controller";
import { SearchController } from "./documents/http/search.controller";
import { UploadsController } from "./documents/http/uploads.controller";
import type { RetryLimiter } from "./documents/retry-limiter";
import { ANSWERER, EMBEDDER } from "./documents/tokens";
import { HealthController } from "./health/health.controller";
import { ErrorFilter } from "./http/error.filter";
import { responseHeaders } from "./http/response-headers.middleware";
import { storageProviders } from "./storage/storage.providers";
import { WorkspacesController } from "./workspaces/workspaces.controller";

@Module({})
export class AppModule implements NestModule {
  static register(
    env: ApiEnv,
    options: {
      hasher?: PasswordHasher;
      store?: DocumentStore;
      embedder?: Embedder;
      answerer?: Answerer;
      uploadTimeouts?: UploadTimeouts;
      searchLimiter?: RetryLimiter;
    } = {},
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        WorkspacesController,
        UploadsController,
        DocumentsController,
        SearchController,
        AnswersController,
      ],
      providers: [
        ...authProviders(env, options.hasher),
        ...storageProviders(env, options.store),
        ...documentProviders(options.uploadTimeouts, options.searchLimiter),
        {
          provide: EMBEDDER,
          useValue:
            options.embedder ??
            createEmbedder({
              provider: env.EMBEDDING_PROVIDER,
              openaiApiKey: env.OPENAI_API_KEY,
              openaiModel: env.OPENAI_EMBEDDING_MODEL,
            }),
        },
        {
          provide: ANSWERER,
          useValue:
            options.answerer ??
            createAnswerer({
              provider: env.ANSWER_PROVIDER,
              openaiApiKey: env.OPENAI_API_KEY,
              openaiModel: env.OPENAI_ANSWER_MODEL,
            }),
        },
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
