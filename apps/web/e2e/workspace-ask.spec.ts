// Real stack, offline providers (hash embeddings, extractive answers): no paid call is possible.
import { signInToLibrary } from "./support/document-fixtures";
import { expect, test } from "./support/support";

const policy = {
  name: "returns-policy.txt",
  mimeType: "text/plain",
  buffer: Buffer.from(
    "Warranty claims: broken sprockets are replaced within 45 days of delivery. Shipping takes a week.",
  ),
};

test("ask a question, read the cited answer, and get an abstention for the unrelated", async ({
  page,
  accounts: [account],
}) => {
  await signInToLibrary(page, account);
  await page.getByLabel("Choose file").setInputFiles(policy);
  await expect(
    page.getByRole("listitem").filter({ hasText: policy.name }).getByText("Ready", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: /Ask your documents/ }).click();
  await page.getByLabel("Ask your documents").fill("When are broken sprockets replaced?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const answer = page.getByTestId("answer");
  await expect(answer).toContainText("replaced within 45 days");
  await answer.getByText(policy.name).click();
  await expect(answer.locator("blockquote")).toContainText("Warranty claims");

  await page
    .getByLabel("Ask your documents")
    .fill("Who painted the ceiling of the Sistine Chapel?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByTestId("abstention")).toContainText("Insufficient evidence");
});

test("a failing answer service shows guidance", async ({ page, accounts: [account] }) => {
  await page.route("**/api/workspaces/*/answers", (route) =>
    route.fulfill({ status: 503, json: { error: { code: "answer.unavailable", requestId: "r" } } }),
  );
  await signInToLibrary(page, account);
  await page.getByRole("link", { name: /Ask your documents/ }).click();
  await page.getByLabel("Ask your documents").fill("anything at all");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByTestId("ask-error")).toContainText("unavailable");
});
