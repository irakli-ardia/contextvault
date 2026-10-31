import { verifiedApi } from "./stack-env";
import { expect, header, signIn, test } from "./support";

const origin = "http://127.0.0.1:3100";
const internal = `127.0.0.1:${verifiedApi().port}`;

test.describe("the same-origin proxy", () => {
  test("forwards every Set-Cookie attribute and never leaks the backend", async ({
    request,
    accounts: [account],
  }) => {
    const res = await request.post("/api/auth/login", {
      data: account,
      headers: { origin, "x-forwarded-proto": "https", "x-forwarded-host": "evil.example" },
    });
    expect(res.status()).toBe(200);
    const cookies = res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie");
    expect(cookies).toHaveLength(1);
    const attrs = (cookies[0]?.value ?? "").split("; ");
    expect(attrs[0]).toMatch(/^cv_session=[A-Za-z0-9_-]{43}$/);
    expect(attrs.slice(1).sort()).toEqual(["HttpOnly", "Max-Age=604800", "Path=/", "SameSite=Lax"]);
    // A spoofed forwarded protocol must not turn on Secure: it follows NODE_ENV only.
    expect(cookies[0]?.value).not.toMatch(/secure|domain/i);

    const everything = JSON.stringify(res.headersArray()) + (await res.text());
    expect(everything).not.toContain(internal);
    expect(header(res, "location")).toBeNull();
    expect(res.headers()["x-powered-by"]).toBeUndefined();
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["cache-control"]).toContain("no-store");
  });

  test("refuses a missing, null, foreign or look-alike Origin on every unsafe method", async ({
    request,
    accounts: [account],
  }) => {
    const origins: (string | undefined)[] = [
      undefined,
      "null",
      "http://evil.example",
      "http://127.0.0.1:3101",
      "https://127.0.0.1:3100",
      `${origin}/`,
      `${origin}.evil.example`,
      "http://x127.0.0.1:3100",
    ];
    for (const value of origins) {
      const headers = value === undefined ? {} : { origin: value };
      for (const send of [
        () => request.post("/api/auth/login", { data: account, headers }),
        () => request.post("/api/auth/logout", { headers }),
      ]) {
        const res = await send();
        expect([res.status(), value]).toEqual([403, value]);
        expect(res.headers()["set-cookie"]).toBeUndefined();
      }
    }
  });

  test("a forged forwarded host cannot make a foreign Origin acceptable", async ({
    request,
    accounts: [account],
  }) => {
    const res = await request.post("/api/auth/login", {
      data: account,
      headers: {
        origin: "http://evil.example",
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
        "x-forwarded-for": "203.0.113.9",
      },
    });
    expect(res.status()).toBe(403);
  });

  test("sends no CORS headers, even for a foreign preflight", async ({
    request,
    page,
    accounts: [account],
  }) => {
    const preflight = await request.fetch("/api/auth/login", {
      method: "OPTIONS",
      headers: {
        origin: "http://evil.example",
        "access-control-request-method": "POST",
      },
    });
    const names = Object.keys(preflight.headers());
    expect(names.filter((n) => n.startsWith("access-control-"))).toEqual([]);
    expect(preflight.status()).not.toBe(200);

    await signIn(page, account);
    const get = await request.get("/api/health", { headers: { origin: "http://evil.example" } });
    expect(Object.keys(get.headers()).filter((n) => n.startsWith("access-control-"))).toEqual([]);
  });

  test("cannot be steered to another host and never redirects off-origin", async ({ request }) => {
    for (const path of [
      "/api//example.com/x",
      "/api/%2f%2fexample.com/x",
      "/api/http://example.com/x",
      "/api/..%2f..%2fetc/passwd",
      "/api/@example.com/",
    ]) {
      const res = await request.get(path, { maxRedirects: 0 });
      // Next may normalise `//` with a redirect; it must stay a relative path on the web origin.
      const location = header(res, "location");
      expect([path, location === null || /^\/(?!\/)/.test(location)]).toEqual([path, true]);
      expect([path, res.status()]).not.toEqual([path, 200]);
    }
  });
});
