import "reflect-metadata";
import { createPasswordHasher } from "@contextvault/auth";
import { loadDatabaseEnv, loadS3Env, parseApiEnv } from "@contextvault/config";
import { createTenantFixture, type TenantFixture } from "@contextvault/db/testing";
import { parsePassword, type UserId } from "@contextvault/domain";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { AppModule } from "./app.module";
import { configureApp } from "./configure-app";

function s3Settings(): Record<string, string> {
  const { NODE_ENV: _, ...s3 } = loadS3Env();
  return s3;
}

export const webOrigin = "http://127.0.0.1:3000";
export const password = "correct horse battery staple";

export async function startApi(
  overrides: Record<string, string> = {},
  options: Parameters<typeof AppModule.register>[1] = {},
) {
  const env = parseApiEnv({
    NODE_ENV: "test",
    API_PORT: "3001",
    API_HOST: "127.0.0.1",
    WEB_ORIGIN: webOrigin,
    DATABASE_URL: loadDatabaseEnv().DATABASE_URL,
    ...s3Settings(),
    ...overrides,
  });
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env, options), {
    logger: false,
    abortOnError: false,
  });
  configureApp(app, env);
  await app.init();
  return { app, env, http: request(app.getHttpServer()) };
}

export type Api = Awaited<ReturnType<typeof startApi>>;

export interface Account {
  readonly id: UserId;
  readonly email: string;
}

const hasher = createPasswordHasher();
let passwordHash: Promise<string> | undefined;

// Seeds a user with a real Argon2id credential (hashed once per process and shared).
export async function seedAccount(fx: TenantFixture): Promise<Account> {
  passwordHash ??= hasher.hash(parsePassword(password));
  const id = await fx.seedUser();
  await fx.seedCredential(id, await passwordHash);
  return { id, email: `${id}@test.invalid` };
}

export const cookieOf = (res: { headers: Record<string, unknown> }): string | undefined => {
  const header = res.headers["set-cookie"];
  return Array.isArray(header) ? String(header[0]) : undefined;
};

export const tokenOf = (setCookie: string | undefined): string =>
  /^(?:__Host-)?cv_session=([^;]*)/.exec(setCookie ?? "")?.[1] ?? "";

export async function loginAs(api: Api, account: Account) {
  const res = await api.http
    .post("/auth/login")
    .set("Origin", api.env.WEB_ORIGIN)
    .send({ email: account.email, password });
  return { res, setCookie: cookieOf(res), token: tokenOf(cookieOf(res)) };
}

export { createTenantFixture };
