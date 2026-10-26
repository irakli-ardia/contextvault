import { loadDatabaseEnv, loadMigrationEnv } from "@contextvault/config";
import type { PasswordHasher } from "@contextvault/domain";
import { createDatabase } from "../client";
import { assertLeastPrivilege } from "../privilege-check";
import type { CliOps } from "./cli";
import { createEnsureWorkspace } from "./ensure-workspace";
import { createOwnerAccounts } from "./owner-accounts";
import { provisionAccount } from "./provision-account";
import { createCredentialReset, resetPassword } from "./reset-password";

// The two connections never share a pool: the owner URL is loaded only for `create`, and the
// application URL is checked to really be the least-privileged role before anything is written.
// The hasher is injected by the entry point, the only non-test file that knows packages/auth.
export async function openOps(
  command: "create" | "reset",
  hasher: PasswordHasher,
): Promise<CliOps> {
  const app = createDatabase({ connectionString: loadDatabaseEnv().DATABASE_URL, poolSize: 1 });
  const owner =
    command === "create"
      ? createDatabase({
          connectionString: loadMigrationEnv().DATABASE_MIGRATION_URL,
          poolSize: 1,
        })
      : undefined;
  const close = async () => {
    await Promise.all([app.close(), owner?.close()]);
  };
  try {
    await assertLeastPrivilege(app.db);
  } catch (error) {
    await close();
    throw error;
  }
  const refuse = () => Promise.reject(new Error("Command not opened"));
  return {
    close,
    provision: (input) =>
      owner === undefined
        ? refuse()
        : provisionAccount(
            {
              owner: createOwnerAccounts(owner.db),
              ensureWorkspace: createEnsureWorkspace(app.db),
              hasher,
            },
            input,
          ),
    reset: (input) =>
      owner === undefined
        ? resetPassword({ reset: createCredentialReset(app.db), hasher }, input)
        : refuse(),
  };
}
