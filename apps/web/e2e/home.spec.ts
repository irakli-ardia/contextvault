import { expect, test } from "@playwright/test";

test("landing page renders its heading and principles without runtime errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);

  await expect(page).toHaveTitle("ContextVault");
  await expect(
    page.getByRole("heading", { level: 1, name: "Answers you can trace to the source." }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(3);

  expect(errors).toEqual([]);
});
