// Real stack, offline providers (hash embeddings): no paid call is possible.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { signInToLibrary } from "./support/document-fixtures";
import { openLab, searchButton, searchRoute, uploadReady } from "./support/search-lab";
import { expect, test } from "./support/support";

const text = (name: string, body: string) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(body),
});
// A token only this run's document contains, so counts and ranks hold in a shared workspace.
const token = `zorblax${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const notes = text(
  "lab-notes.txt",
  `${token} calibration: broken sprockets are replaced within 45 days. <script>window.__xss = 1</script>`,
);
const filler = text("other-notes.txt", "Quarterly budget review happens every March.");

async function expectKeyword(page: Page) {
  // Keyword: only the chunk that has the term, with its raw rank score and offsets.
  const keyword = page.getByTestId("results-keyword").getByTestId("search-result");
  await expect(keyword).toHaveCount(1);
  await expect(keyword).toContainText(notes.name);
  await expect(keyword).toContainText("characters 0–");
  await expect(keyword).toContainText(/Keyword rank score:\s*\d\.\d{4} · rank 1/);
  await expect(keyword).not.toContainText("Vector similarity");
  // The markup in the document is text, never executed.
  await expect(keyword.locator("script")).toHaveCount(0);
  await expect(keyword).toContainText("<script>window.__xss = 1</script>");
  expect(await page.evaluate(() => "__xss" in window)).toBe(false);
}

async function expectVector(page: Page) {
  // Vector: nearest chunks (the unrelated document is listed too); ranks follow position and the
  // only chunk sharing the token is nearest.
  const vector = page.getByTestId("results-vector").getByTestId("search-result");
  await expect(vector.nth(1)).toBeVisible();
  await expect(vector.first()).toContainText(notes.name);
  for (const [index, item] of (await vector.all()).entries()) {
    await expect(item).toContainText(
      new RegExp(`Vector similarity \\(cosine\\):\\s*-?\\d\\.\\d{4} · rank ${index + 1}$`),
    );
  }
  await expect(page.getByTestId("results-vector")).toContainText("nothing matches the query");
}

async function expectHybrid(page: Page) {
  // Hybrid: the chunk found by both signals first, fused from two rank-1 entries (2/61).
  const hybrid = page.getByTestId("results-hybrid").getByTestId("search-result");
  await expect(hybrid.nth(1)).toBeVisible();
  await expect(hybrid.first()).toContainText(notes.name);
  await expect(hybrid.first()).toContainText(
    /RRF order value \(not a relevance score\):\s*0\.032787/,
  );
  await expect(hybrid.first()).toContainText(
    /Vector similarity \(cosine\):\s*-?\d\.\d{4} · rank 1/,
  );
  await expect(hybrid.first()).toContainText(/Keyword rank score:\s*\d\.\d{4} · rank 1/);
  // The rest are vector-only: fused = 1 / (60 + vector rank), rank = list position.
  for (const [index, item] of (await hybrid.all()).entries()) {
    if (index === 0) continue;
    await expect(item).toContainText(/Keyword rank score:\s*not found by keyword search/);
    await expect(item).toContainText(`rank ${index + 1}`);
    await expect(item).toContainText(`${(1 / (61 + index)).toFixed(6)}`);
  }
}

test("compare all sends one query per mode and shows ranked, labelled raw values", async ({
  page,
  accounts: [account],
}) => {
  const sent: unknown[] = [];
  await page.route(searchRoute, (route) => {
    sent.push(route.request().postDataJSON());
    return route.fallback();
  });
  await signInToLibrary(page, account);
  await uploadReady(page, notes);
  await uploadReady(page, filler);

  await openLab(page);
  await page.getByLabel("Search query").fill(`  ${token}  `);
  await page.getByRole("radio", { name: "Compare all" }).check();
  await searchButton(page).click();

  await expect(page.getByTestId("search-context")).toHaveText(
    `Results for “${token}” · Compare all`,
  );
  expect(sent).toHaveLength(3);
  expect(sent).toEqual(
    expect.arrayContaining([
      { query: token, mode: "vector" },
      { query: token, mode: "keyword" },
      { query: token, mode: "hybrid" },
    ]),
  );
  // One live region announces the whole comparison.
  await expect(page.getByRole("status")).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText(
    /^Search complete\. Vector: \d+ results?\. Keyword: 1 result\. Hybrid: \d+ results?\.$/,
  );

  await expectKeyword(page);
  await expectVector(page);
  await expectHybrid(page);
});

test("empty input, Enter, duplicate submits, pending state and stale results", async ({
  page,
  accounts: [account],
}) => {
  const sent: { query: string; mode: string }[] = [];
  const gate = Promise.withResolvers<void>();
  await page.route(searchRoute, async (route) => {
    sent.push(route.request().postDataJSON());
    if (sent.length === 1) await gate.promise;
    await route.fallback();
  });
  await signInToLibrary(page, account);
  await openLab(page);
  const input = page.getByLabel("Search query");

  await expect(searchButton(page)).toBeDisabled();
  await input.fill("   ");
  await expect(searchButton(page)).toBeDisabled();
  await input.press("Enter");
  expect(sent).toHaveLength(0);

  await input.fill("anything");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Searching…" })).toBeDisabled();
  await expect(page.getByRole("status")).toHaveText("Searching…");
  await input.press("Enter");
  gate.resolve();
  await expect(page.getByTestId("search-context")).toHaveText("Results for “anything” · Hybrid");
  expect(sent).toEqual([{ query: "anything", mode: "hybrid" }]);

  // Editing the controls marks the shown results as stale; restoring them clears the mark.
  const results = page.getByTestId("search-results");
  await expect(results).toHaveAttribute("data-stale", "false");
  await input.fill("anything else");
  await expect(results).toHaveAttribute("data-stale", "true");
  await expect(page.getByTestId("search-context")).toContainText("search again to refresh");
  await input.fill("anything");
  await expect(results).toHaveAttribute("data-stale", "false");
  await page.getByRole("radio", { name: "Keyword" }).check();
  await expect(results).toHaveAttribute("data-stale", "true");

  await searchButton(page).click();
  await expect(page.getByTestId("search-context")).toHaveText("Results for “anything” · Keyword");
  await expect(results).toHaveAttribute("data-stale", "false");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual({ query: "anything", mode: "keyword" });
});

test("a keyboard submit keeps focus and a long query does not overflow a phone screen", async ({
  page,
  accounts: [account],
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await signInToLibrary(page, account);
  await openLab(page);
  await page.getByLabel("Search query").fill("x".repeat(900));
  await page.getByRole("radio", { name: "Compare all" }).check();

  await searchButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("search-context")).toBeVisible();
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
