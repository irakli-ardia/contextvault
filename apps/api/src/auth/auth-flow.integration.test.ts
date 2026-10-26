import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  type Api,
  cookieOf,
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
const age = (sql: string) =>
  fx.owner.query(`update sessions set ${sql} where user_id = $1`, [ada.id]);

describe("POST /auth/login", () => {
  it("signs in, sets a hardened cookie, and returns only id and email", async () => {
    const { res, setCookie } = await loginAs(api, ada);
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ user: { id: ada.id, email: ada.email } });
    expect(setCookie).toMatch(
      /^cv_session=[A-Za-z0-9_-]{43}; Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax$/,
    );
    expect(setCookie).not.toMatch(/Domain|Secure/);
    expect(res.text).not.toMatch(/argon2|passwordHash|tokenHash/i);
  });

  it("answers an unknown email and a wrong password identically", async () => {
    const attempt = (email: string, pw: string) =>
      api.http.post("/auth/login").set("Origin", webOrigin).send({ email, password: pw });
    const unknown = await attempt("nobody@test.invalid", password);
    const wrong = await attempt(ada.email, "wrong password entirely");
    for (const res of [unknown, wrong]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("auth.invalid_credentials");
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
    expect(Object.keys(unknown.headers).sort()).toEqual(Object.keys(wrong.headers).sort());
  });

  it.each([
    ["a stray userId", { email: "a@test.invalid", password, userId: "x" }],
    ["a stray workspaceId", { email: "a@test.invalid", password, workspaceId: "x" }],
    ["a missing password", { email: "a@test.invalid" }],
    ["a non-string email", { email: 1, password }],
  ])("rejects %s with 400", async (_name, body) => {
    const res = await api.http.post("/auth/login").set("Origin", webOrigin).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("request.invalid");
  });

  it("never accepts a client-supplied token: login issues a new one and kills the old", async () => {
    const first = await loginAs(api, ada);
    const second = await api.http
      .post("/auth/login")
      .set("Origin", webOrigin)
      .set("Cookie", `cv_session=${first.token}`)
      .send({ email: ada.email, password });
    const issued = tokenOf(cookieOf(second));
    expect(issued).not.toBe(first.token);
    expect((await me(first.token)).status).toBe(401);
    expect((await me(issued)).status).toBe(200);

    const planted = "A".repeat(43);
    const fixated = await loginAs(api, ada);
    expect(fixated.token).not.toBe(planted);
    expect((await me(planted)).status).toBe(401);
  });
});

describe("session resolution", () => {
  it("resolves the user and workspaces from the cookie alone, ignoring forged identity", async () => {
    const other = await seedAccount(fx);
    const workspaceId = await fx.createWorkspace(ada.id, "Ada's");
    await fx.createWorkspace(other.id, "Other's");
    const { token } = await loginAs(api, ada);
    const res = await me(token).set("X-User-Id", other.id).query({ userId: other.id });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: ada.id, email: ada.email });
    expect(res.body.workspaces).toEqual([{ id: workspaceId, name: "Ada's", role: "owner" }]);
  });

  it.each([
    ["no cookie", undefined],
    ["a garbage cookie", "cv_session=not a token"],
    ["a well-formed but unknown token", `cv_session=${"B".repeat(43)}`],
    ["an oversized cookie", `cv_session=${"C".repeat(8_000)}`],
    ["the production cookie name in development", `__Host-cv_session=${"B".repeat(43)}`],
  ])("returns 401 for %s", async (_name, cookie) => {
    const req = api.http.get("/auth/me");
    const res = await (cookie === undefined ? req : req.set("Cookie", cookie));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("auth.unauthenticated");
  });

  it("returns 401 once the session is expired, idle, or revoked", async () => {
    for (const change of [
      "created_at = now() - interval '2 days', expires_at = now() - interval '1 second'",
      "created_at = now() - interval '2 days', last_seen_at = now() - interval '25 hours'",
      "revoked_at = now()",
    ]) {
      const { token } = await loginAs(api, ada);
      expect((await me(token)).status).toBe(200);
      await age(change);
      expect((await me(token)).status).toBe(401);
    }
  });

  it("touches last_seen_at after the touch interval, not on every request", async () => {
    const { token } = await loginAs(api, ada);
    const seen = async (): Promise<Date> => {
      const { rows } = await fx.owner.query<{ last_seen_at: Date }>(
        "select last_seen_at from sessions where user_id = $1 and revoked_at is null",
        [ada.id],
      );
      if (rows[0] === undefined) throw new Error("no live session");
      return rows[0].last_seen_at;
    };
    await age(
      "last_seen_at = now() - interval '10 minutes', created_at = now() - interval '1 day'",
    );
    const before = await seen();
    await me(token);
    const touched = await seen();
    expect(touched.getTime()).toBeGreaterThan(before.getTime());
    await me(token);
    expect((await seen()).getTime()).toBe(touched.getTime());
  });
});

describe("POST /auth/logout", () => {
  it("revokes the session, clears the cookie, and is idempotent", async () => {
    const { token } = await loginAs(api, ada);
    const out = () =>
      api.http.post("/auth/logout").set("Origin", webOrigin).set("Cookie", `cv_session=${token}`);
    const res = await out();
    expect(res.status).toBe(204);
    expect(cookieOf(res)).toMatch(/^cv_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax$/);
    expect((await me(token)).status).toBe(401);
    expect((await out()).status).toBe(204);
    expect((await api.http.post("/auth/logout").set("Origin", webOrigin)).status).toBe(204);
  });
});

describe("login throttling", () => {
  it("answers 429 with Retry-After after repeated failures on one account", async () => {
    const victim = await seedAccount(fx);
    const bad = () =>
      api.http
        .post("/auth/login")
        .set("Origin", webOrigin)
        .send({ email: victim.email, password: "wrong password entirely" });
    for (let i = 0; i < 5; i++) expect((await bad()).status).toBe(401);
    const blocked = await bad();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("auth.throttled");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    // Even the right password is refused while blocked, and the body is the same.
    const right = await loginAs(api, victim);
    expect(right.res.status).toBe(429);
  });
});
