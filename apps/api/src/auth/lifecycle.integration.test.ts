import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  type Api,
  createTenantFixture,
  loginAs,
  password,
  seedAccount,
  startApi,
  tokenOf,
  webOrigin,
} from "../test-support";

const fx = createTenantFixture(4);
let api: Api;
let ada: Account;

beforeAll(async () => {
  api = await startApi();
  ada = await seedAccount(fx);
});
afterAll(async () => {
  await api.app.close();
  await fx.close();
});

const me = (token: string) => api.http.get("/auth/me").set("Cookie", `cv_session=${token}`);
const loginWith = (token: string, body: { email: string; password: string }) =>
  api.http
    .post("/auth/login")
    .set("Origin", webOrigin)
    .set("Cookie", `cv_session=${token}`)
    .send(body);

describe("login and the presented session", () => {
  it("a failed login never revokes the session the request carried", async () => {
    const { token } = await loginAs(api, ada);
    const wrong = await loginWith(token, { email: ada.email, password: "wrong password entirely" });
    const unknown = await loginWith(token, { email: "nobody@test.invalid", password });
    const malformed = await loginWith(token, { email: "x", password: "short" });
    for (const res of [wrong, unknown, malformed]) expect(res.status).toBe(401);
    expect((await me(token)).status).toBe(200);
  });

  it("a successful login revokes it and issues an unrelated fresh token each time", async () => {
    const first = await loginAs(api, ada);
    const seen = new Set([first.token]);
    let presented = first.token;
    for (let i = 0; i < 4; i++) {
      const res = await loginWith(presented, { email: ada.email, password });
      const issued = tokenOf(res.headers["set-cookie"]?.[0]);
      expect(issued).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(seen.has(issued)).toBe(false);
      expect(issued).not.toContain(presented.slice(0, 8));
      expect((await me(presented)).status).toBe(401);
      seen.add(issued);
      presented = issued;
    }
    expect((await me(presented)).status).toBe(200);
  });

  it("a revoked session cannot reach any authenticated route", async () => {
    const { token } = await loginAs(api, ada);
    await api.http
      .post("/auth/logout")
      .set("Origin", webOrigin)
      .set("Cookie", `cv_session=${token}`);
    const id = "0b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f";
    for (const path of ["/auth/me", `/workspaces/${id}`]) {
      const res = await api.http.get(path).set("Cookie", `cv_session=${token}`);
      expect(res.status).toBe(401);
    }
  });
});

describe("error responses leak nothing", () => {
  it("never echo the password, a token, a hash, or set a cookie", async () => {
    const { token } = await loginAs(api, ada);
    const secretPassword = "an-entirely-wrong-password";
    const responses = [
      await loginWith(token, { email: ada.email, password: secretPassword }),
      await api.http.post("/auth/login").send({ email: ada.email, password: secretPassword }),
      await api.http.get("/auth/me").set("Cookie", `cv_session=${"Z".repeat(43)}`),
      await api.http.get("/workspaces/nope").set("Cookie", `cv_session=${token}`),
      await api.http
        .post("/auth/login")
        .set("Origin", webOrigin)
        .set("Content-Type", "application/json")
        .send('{"email": "broken'),
    ];
    for (const res of responses) {
      const dump = JSON.stringify({ body: res.body, text: res.text, headers: res.headers });
      expect(res.status).toBeGreaterThanOrEqual(400);
      for (const secret of [secretPassword, token, "Z".repeat(43), "argon2", "$argon2id"]) {
        expect(dump).not.toContain(secret);
      }
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(Object.keys(res.body.error)).toEqual(["code", "requestId"]);
    }
  });
});
