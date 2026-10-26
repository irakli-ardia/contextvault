import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, startApi } from "../test-support";

// In-process: the real AppModule behind a real HTTP server on an ephemeral port. The database
// pool connects lazily, so health needs no query.
describe("api http surface", () => {
  let api: Api;

  beforeAll(async () => {
    api = await startApi();
  });

  afterAll(async () => {
    await api.app.close();
  });

  it("GET /health is public and returns exactly { status: 'ok' } as JSON", async () => {
    const res = await api.http.get("/health").expect(200);

    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toStrictEqual({ status: "ok" });
  });

  it("returns 404 for an unknown route", async () => {
    await api.http.get("/does-not-exist").expect(404);
  });
});
