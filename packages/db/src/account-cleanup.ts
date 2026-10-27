export interface CleanupClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rowCount: number | null; rows: { n: number }[] }>;
  release(): void;
}
export interface CleanupPool {
  connect(): Promise<CleanupClient>;
}

// Child tables first: workspaces cascade to documents and uploads, so memberships are counted
// after that cascade, and users go last (sessions and credentials cascade from them).
const steps = [
  ["workspaces", "created_by"],
  ["memberships", "user_id"],
  ["users", "id"],
] as const;

// Test-fixture cleanup in one transaction on a role that sees every row. Every listed user must
// exist, so a pool that silently sees nothing cannot report success; what they own may be absent
// (zero is valid), but each delete must remove exactly the rows counted just before it. The error
// carries counts only, never row values.
export async function deleteAccounts(pool: CleanupPool, userIds: readonly string[]): Promise<void> {
  const ids = [...new Set(userIds)];
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const [table, column] of steps) {
      const expected =
        table === "users"
          ? ids.length
          : Number(
              (
                await client.query(
                  `select count(*)::int as n from ${table} where ${column} = any($1)`,
                  [ids],
                )
              ).rows[0]?.n,
            );
      const { rowCount } = await client.query(`delete from ${table} where ${column} = any($1)`, [
        ids,
      ]);
      if (rowCount !== expected) {
        throw new Error(`CLEANUP_COUNT_MISMATCH: ${table} deleted ${rowCount} of ${expected}`);
      }
    }
    await client.query("commit");
  } catch (error) {
    // A dead connection fails the rollback too; the server already aborted, and the cause matters more.
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
