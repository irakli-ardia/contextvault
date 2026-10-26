import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";

// In-process: the real AppModule behind a real HTTP server on an ephemeral port, no services.
describe("api http surface", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns exactly { status: 'ok' } as JSON", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);

    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toStrictEqual({ status: "ok" });
  });

  it("returns 404 for an unknown route", async () => {
    await request(app.getHttpServer()).get("/does-not-exist").expect(404);
  });
});
