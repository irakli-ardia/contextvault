import { randomUUID } from "node:crypto";
import { browserApi, expect, firstWorkspaceId, signIn, test } from "./support";

const sessionCookie = "cv_session";

// The request id is per request by design; everything else must be identical.
function withoutRequestId(body: unknown): unknown {
  if (typeof body === "object" && body !== null && "error" in body) {
    return { error: { ...Object(body.error), requestId: undefined } };
  }
  throw new Error("Not an error body");
}

test.describe("authentication through the web origin", () => {
  test("login sets a hardened cookie and restores the session after reload", async ({
    page,
    context,
    accounts: [account],
  }) => {
    const login = await signIn(page, account);
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ user: { id: expect.any(String), email: account.email } });
    expect(login.headers["cache-control"]).toContain("no-store");

    const cookies = (await context.cookies()).filter((c) => c.name === sessionCookie);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      domain: "127.0.0.1",
      secure: false, // development; production uses __Host- + Secure (API tests)
    });
    expect(await page.evaluate(() => document.cookie)).not.toContain(sessionCookie);

    await page.reload();
    const me = await browserApi(page, "GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      user: { email: account.email },
      workspaces: [{ role: "owner" }],
    });

    const workspace = await browserApi(page, "GET", `/api/workspaces/${firstWorkspaceId(me.body)}`);
    expect(workspace.status).toBe(200);
    expect(workspace.body).toMatchObject({ role: "owner" });
  });

  test("invalid credentials are refused identically for a wrong password and an unknown email", async ({
    page,
    context,
    accounts: [account],
  }) => {
    await page.goto("/");
    const wrong = await browserApi(page, "POST", "/api/auth/login", {
      email: account.email,
      password: `${account.password}x`,
    });
    const unknown = await browserApi(page, "POST", "/api/auth/login", {
      email: `e2e-${randomUUID()}@test.invalid`,
      password: account.password,
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(withoutRequestId(wrong.body)).toEqual(withoutRequestId(unknown.body));
    expect(await context.cookies()).toEqual([]);
  });

  test("logout revokes the session server-side and clears the cookie", async ({
    page,
    context,
    request,
    accounts: [account],
  }) => {
    await signIn(page, account);
    const token = (await context.cookies()).find((c) => c.name === sessionCookie)?.value ?? "";
    expect(token).not.toBe("");

    expect((await browserApi(page, "POST", "/api/auth/logout")).status).toBe(204);
    expect((await context.cookies()).filter((c) => c.name === sessionCookie)).toEqual([]);
    expect((await browserApi(page, "GET", "/api/auth/me")).status).toBe(401);

    // A copied cookie is dead too: revocation is a database row, not just a cleared cookie.
    const replay = await request.get("/api/auth/me", {
      headers: { cookie: `${sessionCookie}=${token}` },
    });
    expect(replay.status()).toBe(401);
  });

  test("unauthenticated requests are refused", async ({ request }) => {
    expect((await request.get("/api/auth/me")).status()).toBe(401);
    expect((await request.get(`/api/workspaces/${randomUUID()}`)).status()).toBe(401);
    const forged = await request.get("/api/auth/me", {
      headers: { cookie: `${sessionCookie}=garbage`, "x-user-id": randomUUID() },
    });
    expect(forged.status()).toBe(401);
  });

  test("another user's, a missing and a malformed workspace id look the same", async ({
    page,
    browser,
    baseURL,
    accounts: [a, b],
  }) => {
    const otherContext = await browser.newContext({ baseURL: baseURL ?? "" });
    const other = await otherContext.newPage();
    await signIn(other, b);
    const foreignId = firstWorkspaceId((await browserApi(other, "GET", "/api/auth/me")).body);
    await otherContext.close();

    await signIn(page, a);
    const replies = await Promise.all(
      [foreignId, randomUUID(), "not-a-uuid", "1' or '1'='1"].map((id) =>
        browserApi(page, "GET", `/api/workspaces/${encodeURIComponent(id)}`),
      ),
    );
    for (const reply of replies) {
      expect(reply.status).toBe(404);
      expect(withoutRequestId(reply.body)).toEqual(withoutRequestId(replies[0]?.body));
    }
  });

  test("no password or session token reaches the API or web logs", async ({
    page,
    context,
    accounts: [account],
  }) => {
    await signIn(page, account);
    const token = (await context.cookies()).find((c) => c.name === sessionCookie)?.value ?? "";
    await browserApi(page, "POST", "/api/auth/login", { email: account.email, password: "x" });
    const { readFileSync } = await import("node:fs");
    for (const log of ["playwright-report/api.log", "playwright-report/web.log"]) {
      const text = readFileSync(log, "utf8");
      for (const secret of [account.password, token]) expect(text).not.toContain(secret);
    }
  });
});
