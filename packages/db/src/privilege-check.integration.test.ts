import { loadDatabaseEnv, loadMigrationEnv } from "@contextvault/config";
import { describe, expect, it } from "vitest";
import { createPersistence } from "./persistence";
import { PrivilegeCheckFailed } from "./privilege-check";

const check = async (connectionString: string) => {
  const persistence = createPersistence({ connectionString, poolSize: 1 });
  try {
    await persistence.assertLeastPrivilege();
  } finally {
    await persistence.close();
  }
};

describe("assertLeastPrivilege", () => {
  it("accepts the application role", async () => {
    await expect(check(loadDatabaseEnv().DATABASE_URL)).resolves.toBeUndefined();
  });

  it("refuses the owner role, without echoing connection data", async () => {
    const url = loadMigrationEnv().DATABASE_MIGRATION_URL;
    const error = await check(url).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PrivilegeCheckFailed);
    expect(String(error)).not.toContain(new URL(url).password);
  });
});
