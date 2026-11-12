import { signInToLibrary } from "./support/document-fixtures";
import { openLab, searchButton, searchRoute } from "./support/search-lab";
import { browserApi, expect, firstWorkspaceId, signIn, test } from "./support/support";

type Stub = "network" | { status: number; code: string; headers?: Record<string, string> };

const cases: { name: string; stub: Stub; message: RegExp }[] = [
  { name: "400", stub: { status: 400, code: "request.invalid" }, message: /1 to 1000 characters/ },
  { name: "403", stub: { status: 403, code: "permission.denied" }, message: /do not have access/ },
  {
    name: "404",
    stub: { status: 404, code: "workspace.not_found" },
    message: /do not have access/,
  },
  {
    name: "503",
    stub: { status: 503, code: "embedding.unavailable" },
    message: /embedding service/,
  },
  {
    name: "500",
    stub: { status: 500, code: "boom.internal" },
    message: /Something went wrong\. Try again\./,
  },
  { name: "network", stub: "network", message: /Cannot reach the server/ },
  {
    name: "429 with Retry-After 0",
    stub: { status: 429, code: "search.throttled", headers: { "retry-after": "0" } },
    message: /Wait a moment and try again/,
  },
];

test("each failure class shows its own guidance, never a raw code", async ({
  page,
  accounts: [account],
}) => {
  let stub: Stub = "network";
  await page.route(searchRoute, (route) =>
    stub === "network"
      ? route.abort()
      : route.fulfill({
          status: stub.status,
          headers: stub.headers ?? {},
          json: { error: { code: stub.code, requestId: "r" } },
        }),
  );
  await signInToLibrary(page, account);
  await openLab(page);
  await page.getByLabel("Search query").fill("anything");

  for (const { name, stub: next, message } of cases) {
    await test.step(name, async () => {
      stub = next;
      await searchButton(page).click();
      const error = page.getByTestId("search-error");
      await expect(error).toHaveText(message);
      await expect(error).not.toContainText("boom.internal");
      await expect(page.getByRole("status")).toContainText(message);
    });
  }

  stub = { status: 401, code: "auth.unauthenticated" };
  await searchButton(page).click();
  await expect(page.getByTestId("search-error")).toContainText("Your session ended.");
  await expect(page.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/login");
});

test("a throttled mode shows the wait and leaves the other modes intact", async ({
  page,
  accounts: [account],
}) => {
  await page.route(searchRoute, async (route) => {
    if (route.request().postDataJSON().mode !== "vector") return route.fallback();
    await route.fulfill({
      status: 429,
      headers: { "retry-after": "17" },
      json: { error: { code: "search.throttled", requestId: "r" } },
    });
  });
  await signInToLibrary(page, account);
  await openLab(page);
  await page.getByLabel("Search query").fill("anything");
  await page.getByRole("radio", { name: "Compare all" }).check();
  await searchButton(page).click();
  await expect(page.getByTestId("results-vector").getByTestId("search-error")).toHaveText(
    "Too many searches. Wait 17 s and try again.",
  );
  // The shared workspace may hold other specs' documents, so only the outcome kind is asserted.
  for (const mode of ["keyword", "hybrid"]) {
    const section = page.getByTestId(`results-${mode}`);
    await expect(section).toContainText(/(No results|\d+ results?)\./);
    await expect(section.getByTestId("search-error")).toHaveCount(0);
  }
});

// Account B: spending the budget would throttle later searches by the same user in this worker.
test("the real per-user limiter refuses Compare all in every mode with its Retry-After", async ({
  page,
  accounts: [, account],
}) => {
  await signInToLibrary(page, account);
  const workspaceId = firstWorkspaceId((await browserApi(page, "GET", "/api/auth/me")).body);
  // Spend the whole budget with keyword searches (no embedding); the cap is the API's own.
  let refused = 0;
  for (let used = 0; used < 100 && refused !== 429; used++) {
    refused = (
      await browserApi(page, "POST", `/api/workspaces/${workspaceId}/search`, {
        query: "limit",
        mode: "keyword",
      })
    ).status;
  }
  expect(refused).toBe(429);

  await openLab(page);
  await page.getByLabel("Search query").fill("limit");
  await page.getByRole("radio", { name: "Compare all" }).check();
  await searchButton(page).click();
  const errors = page.getByTestId("search-error");
  await expect(errors).toHaveCount(3);
  for (const error of await errors.all()) {
    await expect(error).toHaveText(/^Too many searches\. Wait [1-9]\d* s and try again\.$/);
  }
});

test("another account cannot open or search a foreign workspace; anonymous is redirected", async ({
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
  const reply = await browserApi(page, "POST", `/api/workspaces/${foreignId}/search`, {
    query: "zorblax",
    mode: "hybrid",
  });
  expect(reply.status).toBe(404);
  const response = await page.goto(`/workspace/${foreignId}/search`);
  expect(response?.status()).toBe(404);

  const anonymousContext = await browser.newContext({ baseURL: baseURL ?? "" });
  const anonymous = await anonymousContext.newPage();
  await anonymous.goto(`/workspace/${foreignId}/search`);
  await expect(anonymous).toHaveURL(/\/login/);
  await anonymousContext.close();
});
