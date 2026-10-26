import { randomBytes, randomUUID } from "node:crypto";
import { assertArgon2Runtime, createPasswordHasher } from "@contextvault/auth";
import { loadEnv, loadMigrationEnv } from "@contextvault/config";
import { sql } from "drizzle-orm";
import { createDatabase } from "./client";
import { openOps } from "./provisioning/open-ops";

// Browser-test fixtures, run by Playwright as a child process (never imported by an app):
//   e2e-accounts create <n>        -> JSON [{ email, password }] on stdout
//   e2e-accounts remove <email>... -> deletes those accounts, their workspaces and sessions
// Accounts use the real provisioning path and hasher; passwords are random per run, so no
// credential is stored anywhere. Only `e2e-*@test.invalid` addresses can be removed.
const emailPattern = /^e2e-[0-9a-f-]{36}@test\.invalid$/;
const [command, ...args] = process.argv.slice(2);

async function create(count: number): Promise<void> {
  await assertArgon2Runtime();
  const ops = await openOps("create", createPasswordHasher());
  const accounts: { email: string; password: string }[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const account = {
        email: `e2e-${randomUUID()}@test.invalid`,
        password: randomBytes(18).toString("base64url"),
      };
      await ops.provision({ ...account, confirmation: account.password });
      accounts.push(account);
    }
  } finally {
    await ops.close();
  }
  console.log(JSON.stringify(accounts));
}

async function remove(emails: string[]): Promise<void> {
  if (!emails.every((email) => emailPattern.test(email))) throw new Error("Not an e2e account");
  const owner = createDatabase({
    connectionString: loadMigrationEnv().DATABASE_MIGRATION_URL,
    poolSize: 1,
  });
  try {
    const list = sql.join(
      emails.map((email) => sql`${email}`),
      sql`, `,
    );
    const ids = sql`(select id from users where email in (${list}))`;
    await owner.db.execute(sql`delete from memberships where user_id in ${ids}`);
    await owner.db.execute(sql`delete from workspaces where created_by in ${ids}`);
    await owner.db.execute(sql`delete from users where email in (${list})`);
  } finally {
    await owner.close();
  }
}

function run(): Promise<void> {
  if (loadEnv().NODE_ENV === "production") return Promise.reject(new Error("Refused"));
  if (command === "create") return create(Number(args[0]));
  if (command === "remove") return remove(args);
  return Promise.reject(new Error("Usage: create <n> | remove <email>..."));
}

run().catch(() => {
  // Fixed code only: error text may carry connection details.
  console.error("E2E_ACCOUNTS_FAILED");
  process.exitCode = 1;
});
