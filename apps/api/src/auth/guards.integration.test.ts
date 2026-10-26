import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HealthController } from "../health/health.controller";
import {
  type Account,
  type Api,
  cookieOf,
  createTenantFixture,
  loginAs,
  password,
  seedAccount,
  startApi,
  webOrigin,
} from "../test-support";
import { WorkspacesController } from "../workspaces/workspaces.controller";
import { AuthController } from "./auth.controller";
import { isPublicKey } from "./public.decorator";

const fx = createTenantFixture(4);
let api: Api;
let ada: Account;
let adaToken: string;
let workspaceId: string;

beforeAll(async () => {
  api = await startApi();
  ada = await seedAccount(fx);
  workspaceId = await fx.createWorkspace(ada.id, "Ada's");
  adaToken = (await loginAs(api, ada)).token;
});
afterAll(async () => {
  await api.app.close();
  await fx.close();
});

const cookie = (token: string) => `cv_session=${token}`;

describe("route inventory", () => {
  it("every route is on an exact public allowlist or default-deny (401 without a cookie)", () => {
    const isRoute = (fn: unknown): fn is () => unknown =>
      typeof fn === "function" && Reflect.getMetadata("path", fn) !== undefined;
    const publicRoutes = [HealthController, AuthController, WorkspacesController].flatMap((c) =>
      Object.getOwnPropertyNames(c.prototype)
        .map(
          (name) =>
            [
              `${c.name}.${name}`,
              Reflect.getOwnPropertyDescriptor(c.prototype, name)?.value,
            ] as const,
        )
        .filter(([, fn]) => isRoute(fn) && Reflect.getMetadata(isPublicKey, fn) === true)
        .map(([name]) => name),
    );
    expect(publicRoutes.sort()).toEqual([
      "AuthController.login",
      "AuthController.logout",
      "HealthController.check",
    ]);
  });

  it.each([`/auth/me`, `/workspaces/${randomUUID()}`])(
    "GET %s without a cookie is 401",
    async (path) => {
      expect((await api.http.get(path)).status).toBe(401);
    },
  );
});

// Only login and logout are unsafe routes in M1.2; later unsafe routes pass through the same
// global guard, which runs before any handler.
describe("CSRF: unsafe methods need the exact configured Origin", () => {
  const targets = [
    (origin?: string) => {
      const r = api.http.post("/auth/login");
      return (origin === undefined ? r : r.set("Origin", origin)).send({
        email: ada.email,
        password,
      });
    },
    (origin?: string) => {
      const r = api.http.post("/auth/logout");
      return origin === undefined ? r : r.set("Origin", origin);
    },
  ];
  const bad = [
    undefined,
    "null",
    "http://evil.test",
    `${webOrigin}/`,
    `${webOrigin}.evil.test`,
    `x${webOrigin}`,
    "http://127.0.0.1:3001",
    "https://127.0.0.1:3000",
    webOrigin.toUpperCase(),
  ];

  it.each(bad)("refuses Origin %j on every unsafe route with 403", async (origin) => {
    for (const send of targets) {
      const res = await send(origin);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("request.forbidden_origin");
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("accepts the exact origin, and ignores spoofed forwarded headers", async () => {
    const res = await targets[1]?.(webOrigin)
      .set("X-Forwarded-Host", "evil.test")
      .set("X-Forwarded-Proto", "https");
    expect(res?.status).toBe(204);
    const forged = await targets[1]?.("http://evil.test").set("X-Forwarded-Host", "127.0.0.1:3000");
    expect(forged?.status).toBe(403);
  });

  it("does not restrict safe methods and sends no CORS headers, even to a preflight", async () => {
    const get = await api.http
      .get("/auth/me")
      .set("Origin", "http://evil.test")
      .set("Cookie", cookie(adaToken));
    expect(get.status).toBe(200);
    const preflight = await api.http
      .options("/auth/login")
      .set("Origin", "http://evil.test")
      .set("Access-Control-Request-Method", "POST");
    for (const res of [get, preflight]) {
      expect(Object.keys(res.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    }
  });
});

describe("workspace guard", () => {
  const get = (id: string, token = adaToken) =>
    api.http.get(`/workspaces/${id}`).set("Cookie", cookie(token));

  it("returns the workspace and role to a member", async () => {
    const res = await get(workspaceId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: workspaceId, name: "Ada's", role: "owner" });
  });

  it("answers non-member, nonexistent, and malformed ids identically with 404", async () => {
    const stranger = await seedAccount(fx);
    const strangerToken = (await loginAs(api, stranger)).token;
    const responses = [
      await get(workspaceId, strangerToken),
      await get(randomUUID()),
      await get("not-a-uuid"),
      await get("'; drop table workspaces; --"),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
      expect(Object.keys(res.body.error)).toEqual(["code", "requestId"]);
      expect(Object.keys(res.headers).sort()).toEqual(
        Object.keys(responses[0]?.headers ?? {}).sort(),
      );
    }
  });

  it("ignores a forged workspace or user id in headers and query", async () => {
    const other = await seedAccount(fx);
    const theirs = await fx.createWorkspace(other.id, "Theirs");
    const res = await get(theirs)
      .set("X-User-Id", other.id)
      .set("X-Workspace-Id", theirs)
      .query({ userId: other.id });
    expect(res.status).toBe(404);
  });

  it("refuses the next request after membership is removed", async () => {
    const member = await seedAccount(fx);
    const id = await fx.createWorkspace(member.id, "Short-lived");
    const { token } = await loginAs(api, member);
    expect((await get(id, token)).status).toBe(200);
    await fx.owner.query("delete from memberships where user_id = $1", [member.id]);
    expect((await get(id, token)).status).toBe(404);
  });
});

describe("response hygiene", () => {
  it("marks every response uncacheable and unsniffable with a server-minted request id", async () => {
    const responses = [
      await api.http.get("/health"),
      await api.http.get("/auth/me"),
      await api.http.get("/nope"),
      await api.http.get("/health").set("X-Request-Id", "client-chosen"),
    ];
    for (const res of responses) {
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers["x-powered-by"]).toBeUndefined();
      // The API never redirects: a Location would leak internal URLs through the web rewrite.
      expect(res.status >= 300 && res.status < 400).toBe(false);
    }
    expect(responses[3]?.headers["x-request-id"]).not.toBe("client-chosen");
  });

  it("puts the same request id in the error body and the header", async () => {
    const res = await api.http.get("/auth/me");
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  });
});

describe("production settings", () => {
  it("uses the __Host- Secure cookie and an https origin", async () => {
    const origin = "https://app.example.test";
    const prod = await startApi({
      NODE_ENV: "production",
      WEB_ORIGIN: origin,
      TRUSTED_PROXY_HOPS: "1",
    });
    try {
      const res = await prod.http
        .post("/auth/login")
        .set("Origin", origin)
        .send({ email: ada.email, password });
      expect(cookieOf(res)).toMatch(
        /^__Host-cv_session=[A-Za-z0-9_-]{43}; Max-Age=604800; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
      );
      expect(cookieOf(res)).not.toMatch(/Domain/);
      const out = await prod.http.post("/auth/logout").set("Origin", origin);
      expect(cookieOf(out)).toBe(
        "__Host-cv_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
      );
      const http = await prod.http.post("/auth/logout").set("Origin", webOrigin);
      expect(http.status).toBe(403);
    } finally {
      await prod.app.close();
    }
  });
});
