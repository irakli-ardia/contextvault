import { randomBytes, randomUUID } from "node:crypto";
import { assertArgon2Runtime, createPasswordHasher } from "@contextvault/auth";
import { loadEnv, loadFixtureEnv } from "@contextvault/config";
import pg from "pg";
import { deleteAccounts } from "./account-cleanup";
import { openOps } from "./provisioning/open-ops";

// Browser-test fixtures, run by Playwright as a child process (never imported by an app):
//   e2e-accounts create <n>        -> JSON [{ email, password }] on stdout
//   e2e-accounts remove <email>... -> deletes those accounts, their workspaces and sessions
//   e2e-accounts inspect <workspaceId> -> JSON [{ documents, pending }] (read only)
//   e2e-accounts keys <email>...   -> JSON of every object key those accounts' workspaces reference
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

// Fixture DML and reads run on DATABASE_FIXTURE_URL (no fallback); `create` goes through
// openOps, which keeps the provisioning path on the migration role.
async function withFixture<T>(work: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: loadFixtureEnv().DATABASE_FIXTURE_URL, max: 1 });
  pool.on("error", () => undefined);
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

async function remove(emails: string[]): Promise<void> {
  if (!emails.every((email) => emailPattern.test(email))) throw new Error("Not an e2e account");
  await withFixture(async (pool) => {
    const { rows } = await pool.query<{ id: string }>(
      "select id from users where email = any($1)",
      [emails],
    );
    // deleteAccounts only knows the ids it is given, so a missing account is caught here.
    if (rows.length !== new Set(emails).size) throw new Error("E2E account missing");
    await deleteAccounts(
      pool,
      rows.map((row) => row.id),
    );
  });
}

// Read-only views for browser tests that must see the database, not just HTTP answers.
function query(text: string, values: unknown[]): Promise<void> {
  return withFixture(async (pool) => {
    console.log(JSON.stringify((await pool.query(text, values)).rows));
  });
}

const uuidPattern = /^[0-9a-f-]{36}$/;

function inspect(workspaceId: string): Promise<void> {
  if (!uuidPattern.test(workspaceId)) throw new Error("Not a workspace id");
  return query(
    `select
    (select coalesce(json_agg(json_build_object('id', d.id, 'displayName', d.display_name,
       'mime', d.mime, 'sizeBytes', d.size_bytes, 'sha256', encode(d.content_sha256, 'hex'),
       'status', v.status, 'storageKey', v.storage_key) order by d.created_at), '[]'::json)
     from documents d join document_versions v on v.document_id = d.id
     where d.workspace_id = $1::uuid) as documents,
    (select coalesce(json_agg(json_build_object('id', p.id, 'storageKey', p.storage_key,
       'declaredBytes', p.declared_bytes)), '[]'::json)
     from pending_uploads p where p.workspace_id = $1::uuid) as pending`,
    [workspaceId],
  );
}

function keys(emails: string[]): Promise<void> {
  if (!emails.every((email) => emailPattern.test(email))) throw new Error("Not an e2e account");
  const owned =
    "select id from workspaces where created_by in (select id from users where email = any($1))";
  return query(
    `select storage_key as key from document_versions where workspace_id in (${owned})
     union select storage_key from pending_uploads where workspace_id in (${owned})`,
    [emails],
  );
}

function run(): Promise<void> {
  if (loadEnv().NODE_ENV === "production") return Promise.reject(new Error("Refused"));
  if (command === "create") return create(Number(args[0]));
  if (command === "remove") return remove(args);
  if (command === "inspect") return inspect(String(args[0]));
  if (command === "keys") return keys(args);
  return Promise.reject(
    new Error("Usage: create <n> | remove <email>... | inspect <id> | keys <email>..."),
  );
}

run().catch(() => {
  // Fixed code only: error text may carry connection details.
  console.error("E2E_ACCOUNTS_FAILED");
  process.exitCode = 1;
});
