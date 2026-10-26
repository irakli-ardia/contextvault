import { execFileSync } from "node:child_process";
import { type APIResponse, test as base, expect, type Page } from "@playwright/test";

export interface Account {
  readonly email: string;
  readonly password: string;
}

// The seeder is the bundled operator tooling (`packages/db`): real provisioning and Argon2id,
// random passwords per run, removal of exactly the accounts it created.
function seeder(args: string[]): string {
  return execFileSync(
    "node",
    ["--env-file-if-exists=.env", "packages/db/dist/e2e-accounts.mjs", ...args],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

function isAccount(value: unknown): value is Account {
  return (
    typeof value === "object" &&
    value !== null &&
    "email" in value &&
    typeof value.email === "string" &&
    "password" in value &&
    typeof value.password === "string"
  );
}

export const test = base.extend<object, { accounts: [Account, Account] }>({
  accounts: [
    // Playwright needs a destructuring pattern to see the fixture's (here: no) dependencies.
    async ({ playwright: _unused }, use) => {
      const [a, b]: unknown[] = JSON.parse(seeder(["create", "2"]));
      if (!isAccount(a) || !isAccount(b)) throw new Error("Fixture accounts missing");
      try {
        await use([a, b]);
      } finally {
        seeder(["remove", a.email, b.email]);
      }
    },
    { scope: "worker" },
  ],
});

export { expect };

export interface ApiReply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

/** A same-origin `fetch` from the page: the browser adds the real Origin and uses its cookie jar. */
export function browserApi(page: Page, method: string, path: string, json?: unknown) {
  return page.evaluate(
    async ({ method, path, json }): Promise<ApiReply> => {
      const res = await fetch(path, {
        method,
        headers: json === undefined ? {} : { "content-type": "application/json" },
        body: json === undefined ? null : JSON.stringify(json),
        redirect: "manual",
      });
      const text = await res.text();
      return {
        status: res.status,
        body: text === "" ? null : JSON.parse(text),
        headers: Object.fromEntries(res.headers),
      };
    },
    { method, path, json },
  );
}

export async function signIn(page: Page, account: Account): Promise<ApiReply> {
  await page.goto("/");
  return browserApi(page, "POST", "/api/auth/login", account);
}

/** One header value, or null; avoids the index-signature access that lint and tsc disagree on. */
export function header(res: APIResponse, name: string): string | null {
  return res.headersArray().find((h) => h.name.toLowerCase() === name)?.value ?? null;
}

/** The id of the first workspace in an `/auth/me` body; throws if the shape differs. */
export function firstWorkspaceId(body: unknown): string {
  if (typeof body === "object" && body !== null && "workspaces" in body) {
    const [first]: unknown[] = Array.isArray(body.workspaces) ? body.workspaces : [];
    if (
      typeof first === "object" &&
      first !== null &&
      "id" in first &&
      typeof first.id === "string"
    )
      return first.id;
  }
  throw new Error("No workspace in /auth/me response");
}
