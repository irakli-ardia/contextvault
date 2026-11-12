import type { Page } from "@playwright/test";
import { type Account, browserApi, expect, test } from "./support/support";

const sessionCookie = "cv_session";

async function fillAndSubmit(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function signInThroughForm(page: Page, account: Account) {
  await page.goto("/login");
  await fillAndSubmit(page, account.email, account.password);
  await expect(page).toHaveURL(/\/workspace$/);
}

test.describe("login journey", () => {
  test("a protected route sends an anonymous visitor to the login page", async ({ page }) => {
    await page.goto("/workspace");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  });

  test("wrong credentials show one generic message and set no cookie", async ({
    page,
    context,
    accounts: [account],
  }) => {
    await page.goto("/login");
    await fillAndSubmit(page, account.email, `${account.password}x`);
    await expect(page.locator("form").getByRole("alert")).toHaveText(
      "Email or password is incorrect.",
    );
    await expect(page).toHaveURL(/\/login$/);
    expect(await context.cookies()).toEqual([]);

    // The same message for an unknown account: the form is no account oracle.
    await fillAndSubmit(page, "nobody@test.invalid", account.password);
    await expect(page.locator("form").getByRole("alert")).toHaveText(
      "Email or password is incorrect.",
    );
  });

  test("the browser blocks an empty submission before any request", async ({ page }) => {
    let requests = 0;
    page.on("request", (r) => r.url().includes("/api/auth/login") && requests++);
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByLabel("Email")).toHaveJSProperty("validity.valueMissing", true);
    expect(requests).toBe(0);
  });

  test("sign-in lands on the workspace; the token never reaches page storage", async ({
    page,
    context,
    accounts: [account],
  }) => {
    await signInThroughForm(page, account);
    await expect(page.getByRole("heading", { level: 1, name: "Your workspaces" })).toBeVisible();
    await expect(page.getByRole("link", { name: account.email })).toBeVisible();

    const cookie = (await context.cookies()).find((c) => c.name === sessionCookie);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    const stored = await page.evaluate(() =>
      JSON.stringify([
        Object.entries(localStorage),
        Object.entries(sessionStorage),
        document.cookie,
      ]),
    );
    expect(stored).toBe('[[],[],""]');

    await page.reload();
    await expect(page).toHaveURL(/\/workspace$/);
    await page.goto("/");
    await expect(page.getByRole("link", { name: account.email })).toBeVisible();
    await page.goto("/login");
    await expect(page).toHaveURL(/\/workspace$/);
  });

  test("sign-out ends the session and protects the route again", async ({
    page,
    accounts: [account],
  }) => {
    await signInThroughForm(page, account);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await page.goto("/workspace");
    await expect(page).toHaveURL(/\/login$/);
    expect((await browserApi(page, "GET", "/api/auth/me")).status).toBe(401);
  });

  test("a session revoked elsewhere is refused on the next visit", async ({
    page,
    accounts: [account],
  }) => {
    await signInThroughForm(page, account);
    expect((await browserApi(page, "POST", "/api/auth/logout")).status).toBe(204);
    await page.goto("/workspace");
    await expect(page).toHaveURL(/\/login$/);
  });
});
