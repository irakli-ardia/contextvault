import type { Page } from "@playwright/test";
import { expect } from "./support";

export const searchRoute = "**/api/workspaces/*/search";

export async function openLab(page: Page) {
  await page.getByRole("link", { name: /Retrieval Lab/ }).click();
  await expect(page.getByLabel("Search query")).toBeVisible();
}

export const searchButton = (page: Page) =>
  page.getByRole("button", { name: "Search", exact: true });

export async function uploadReady(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  await page.getByLabel("Choose file").setInputFiles(file);
  await expect(
    page.getByRole("listitem").filter({ hasText: file.name }).getByText("Ready", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}
