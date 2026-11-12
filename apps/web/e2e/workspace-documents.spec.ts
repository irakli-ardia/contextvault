// Named to run after upload-api.spec.ts: that spec counts the shared accounts' documents, and
// deleted rows stay (soft delete) until the purge.
import { encryptedPdf, markdown, signInToLibrary } from "./support/document-fixtures";
import { browserApi, expect, test } from "./support/support";

const row = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("listitem").filter({ hasText: name });

test.describe("document upload and processing", () => {
  test("login, upload, processing to ready, delete", async ({ page, accounts: [account] }) => {
    await signInToLibrary(page, account);

    await page.getByLabel("Choose file").setInputFiles(markdown("library-notes.md"));
    await expect(page.getByText("Uploaded. Processing has started.")).toBeVisible();
    // Polling moves the badge on its own; the test never reloads.
    await expect(row(page, "library-notes.md").getByText("Ready", { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole("button", { name: "Delete library-notes.md" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(row(page, "library-notes.md")).toBeVisible();

    await page.getByRole("button", { name: "Delete library-notes.md" }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(row(page, "library-notes.md")).toHaveCount(0);
  });

  test("an empty library explains what to do", async ({ page, accounts: [account] }) => {
    await page.route("**/api/workspaces/*/documents", (route) =>
      route.fulfill({ json: { documents: [] } }),
    );
    await signInToLibrary(page, account);
    await expect(page.getByText("No documents yet.")).toBeVisible();
  });

  test("client validation refuses an unsupported file before any request", async ({
    page,
    accounts: [account],
  }) => {
    await signInToLibrary(page, account);
    let uploads = 0;
    page.on("request", (r) => r.url().endsWith("/uploads") && uploads++);
    await page
      .getByLabel("Choose file")
      .setInputFiles({ name: "data.csv", mimeType: "text/csv", buffer: Buffer.from("a,b") });
    await expect(page.locator("main").getByRole("alert").first()).toContainText(
      "Only PDF, Markdown",
    );
    expect(uploads).toBe(0);
  });

  test("an encrypted PDF fails with guidance and no retry", async ({
    page,
    accounts: [account],
  }) => {
    await signInToLibrary(page, account);
    await page.getByLabel("Choose file").setInputFiles(encryptedPdf("locked-doc.pdf"));
    const locked = row(page, "locked-doc.pdf");
    await expect(locked.getByText("Failed", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(locked).toContainText("password-protected");
    await expect(locked.getByRole("button", { name: "Retry" })).toHaveCount(0);

    await locked.getByRole("button", { name: "Delete locked-doc.pdf" }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(locked).toHaveCount(0);
  });
});

test.describe("document retry", () => {
  test("retry is offered for a retryable failure and requeues it", async ({
    page,
    accounts: [account],
  }) => {
    const doc = {
      id: "6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
      displayName: "flaky-doc.pdf",
      mime: "application/pdf",
      sizeBytes: 2048,
      createdAt: new Date().toISOString(),
    };
    let retried = false;
    // A natural retryable failure (timeout) cannot be produced on demand, so the API is stubbed.
    await page.route("**/api/workspaces/*/documents", (route) =>
      route.fulfill({
        json: {
          documents: [
            retried
              ? { ...doc, status: "queued", error: null }
              : { ...doc, status: "failed", error: { code: "parse.timeout", retryable: true } },
          ],
        },
      }),
    );
    await page.route("**/api/workspaces/*/documents/*/retry", (route) => {
      retried = true;
      return route.fulfill({ status: 202, json: { ...doc, status: "queued", error: null } });
    });
    await signInToLibrary(page, account);
    const flaky = row(page, "flaky-doc.pdf");
    await expect(flaky).toContainText("took too long");
    await flaky.getByRole("button", { name: "Retry" }).click();
    await expect(flaky.getByText("Queued", { exact: true })).toBeVisible();
    await expect(flaky.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });

  test("a rate-limited retry shows the wait time", async ({ page, accounts: [account] }) => {
    const doc = {
      id: "6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
      displayName: "flaky-doc.pdf",
      mime: "application/pdf",
      sizeBytes: 2048,
      status: "failed",
      error: { code: "parse.timeout", retryable: true },
      createdAt: new Date().toISOString(),
    };
    await page.route("**/api/workspaces/*/documents", (route) =>
      route.fulfill({ json: { documents: [doc] } }),
    );
    await page.route("**/api/workspaces/*/documents/*/retry", (route) =>
      route.fulfill({
        status: 429,
        headers: { "retry-after": "12" },
        json: { error: { code: "retry.throttled", requestId: "r1" } },
      }),
    );
    await signInToLibrary(page, account);
    await row(page, "flaky-doc.pdf").getByRole("button", { name: "Retry" }).click();
    await expect(page.locator("main").getByRole("alert").first()).toContainText("Retry in 12s");
  });
});

test.describe("access and session", () => {
  test("an anonymous visitor is sent to sign in", async ({ page, accounts: [account] }) => {
    await signInToLibrary(page, account);
    const url = page.url();
    await page.context().clearCookies();
    await page.goto(url);
    await expect(page).toHaveURL(/\/login$/);
  });

  test("another account's workspace is not found", async ({ page, accounts: [a, b] }) => {
    await signInToLibrary(page, b);
    const own = page.url();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await signInToLibrary(page, a);
    await page.goto(own);
    await expect(page.getByText(/could not be found|404/i).first()).toBeVisible();
  });

  test("a revoked session shows sign-in guidance instead of a broken page", async ({
    page,
    accounts: [account],
  }) => {
    await signInToLibrary(page, account);
    expect((await browserApi(page, "POST", "/api/auth/logout")).status).toBe(204);
    await page.getByLabel("Choose file").setInputFiles(markdown("late.md"));
    await expect(page.locator("main").getByRole("alert").first()).toContainText(
      "Your session has ended",
    );
  });
});
