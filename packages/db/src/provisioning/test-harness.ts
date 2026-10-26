import { randomUUID } from "node:crypto";
import { createPasswordHasher, createSessionTokens } from "@contextvault/auth";
import { loadDatabaseEnv, loadMigrationEnv } from "@contextvault/config";
import {
  login,
  parseEmail,
  parsePassword,
  parseSessionId,
  parseUserId,
} from "@contextvault/domain";
import { createDatabase } from "../client";
import { createTenantFixture } from "../tenant-fixture";
import { createEnsureWorkspace, type EnsureWorkspace } from "./ensure-workspace";
import { createOwnerAccounts, type OwnerAccounts } from "./owner-accounts";
import type { ProvisionDeps } from "./provision-account";
import { createCredentialReset } from "./reset-password";

export const password = "correct horse battery";

// Real Postgres: owner connection for accounts, application role for everything else, cleanup of
// the accounts the provisioning commands (not the fixture) created.
export function provisioningHarness() {
  const fx = createTenantFixture(2);
  const owner = createDatabase({
    connectionString: loadMigrationEnv().DATABASE_MIGRATION_URL,
    poolSize: 1,
  });
  const app = createDatabase({ connectionString: loadDatabaseEnv().DATABASE_URL, poolSize: 2 });
  const hasher = createPasswordHasher();
  const emails: string[] = [];

  const deps = (
    wrap: {
      owner?: (real: OwnerAccounts) => OwnerAccounts;
      ensureWorkspace?: (real: EnsureWorkspace) => EnsureWorkspace;
    } = {},
  ): ProvisionDeps => {
    const realOwner = createOwnerAccounts(owner.db);
    const realEnsure = createEnsureWorkspace(app.db);
    return {
      hasher,
      owner: wrap.owner?.(realOwner) ?? realOwner,
      ensureWorkspace: wrap.ensureWorkspace?.(realEnsure) ?? realEnsure,
    };
  };

  // The real login use case over the real stores: the proof that an account can (not) sign in.
  const attemptLogin = async (email: string, plain: string) =>
    login(
      {
        credentials: fx.persistence.auth.credentials,
        sessions: fx.persistence.auth.sessions,
        hasher,
        tokens: createSessionTokens(),
        now: () => new Date(),
        newSessionId: () => parseSessionId(randomUUID()),
        dummyHash: await hasher.hash(parsePassword("dummy dummy dummy")),
      },
      { email, password: plain, presentedTokenHash: null },
    );

  return {
    fx,
    hasher,
    attemptLogin,
    app,
    deps,
    reset: createCredentialReset(app.db),
    newEmail() {
      const email = `${randomUUID()}@test.invalid`;
      emails.push(email);
      return parseEmail(email);
    },
    async idOf(email: string) {
      const rows = (
        await fx.owner.query<{ id: string }>("select id from users where email = $1", [email])
      ).rows;
      return parseUserId(rows[0]?.id ?? "");
    },
    async accountOf(email: string) {
      const [user] = (
        await fx.owner.query<{ id: string }>("select id from users where email = $1", [email])
      ).rows;
      const count = async (table: string, column: string) =>
        Number(
          (
            await fx.owner.query<{ n: string }>(
              `select count(*) n from ${table} where ${column} = $1`,
              [user?.id],
            )
          ).rows[0]?.n,
        );
      return {
        exists: user !== undefined,
        id: user?.id ?? "",
        credentials: user === undefined ? 0 : await count("user_credentials", "user_id"),
        memberships: user === undefined ? 0 : await count("memberships", "user_id"),
        workspaces: user === undefined ? 0 : await count("workspaces", "created_by"),
      };
    },
    async close() {
      const ids = (
        await fx.owner.query<{ id: string }>("select id from users where email = any($1)", [emails])
      ).rows.map((r) => r.id);
      await fx.owner.query("delete from workspaces where created_by = any($1)", [ids]);
      await fx.owner.query("delete from memberships where user_id = any($1)", [ids]);
      await fx.owner.query("delete from users where id = any($1)", [ids]);
      await Promise.all([owner.close(), app.close()]);
      await fx.close();
    },
  };
}
