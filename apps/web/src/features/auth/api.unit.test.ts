import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSession, login } from "./api";

const stub = (body: unknown, status = 200) =>
  vi.stubGlobal("fetch", async () => Response.json(body, { status }));

afterEach(() => vi.unstubAllGlobals());

describe("auth DAL", () => {
  it("treats 401 from /auth/me as signed out, not as a fault", async () => {
    stub({ error: { code: "auth.unauthenticated", requestId: "r" } }, 401);
    expect(await fetchSession()).toBeNull();
  });

  it("still throws for a server fault", async () => {
    stub({ error: { code: "internal", requestId: "r" } }, 500);
    await expect(fetchSession()).rejects.toMatchObject({ status: 500 });
  });

  it("rejects a login body carrying anything beyond the user", async () => {
    stub({ user: { id: "u", email: "a@b.c" }, token: "leak" });
    await expect(login({ email: "a@b.c", password: "x" })).rejects.toMatchObject({
      code: "response.invalid",
    });
  });
});
