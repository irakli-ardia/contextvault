import { describe, expect, it } from "vitest";
import { type CleanupClient, deleteAccounts } from "./account-cleanup";

// Scripted client: `counts` answers the select, `deleted` the delete, per table.
function fakePool(counts: Record<string, number>, deleted: Record<string, number>) {
  const log: string[] = [];
  let released = 0;
  const client: CleanupClient = {
    async query(text) {
      const table = /(?:from) (\w+)/.exec(text)?.[1] ?? "";
      log.push(text.startsWith("delete") ? `delete ${table}` : (text.split(" ")[0] ?? ""));
      if (text.startsWith("select")) return { rowCount: 1, rows: [{ n: counts[table] ?? 0 }] };
      if (text.startsWith("delete")) return { rowCount: deleted[table] ?? 0, rows: [] };
      return { rowCount: null, rows: [] };
    },
    release: () => {
      released++;
    },
  };
  return { pool: { connect: async () => client }, log, released: () => released };
}

describe("deleteAccounts", () => {
  it("commits when every delete matches its count, children before users", async () => {
    const p = fakePool(
      { workspaces: 1, memberships: 2 },
      { workspaces: 1, memberships: 2, users: 2 },
    );
    await deleteAccounts(p.pool, ["a", "b", "a"]);
    expect(p.log).toEqual([
      "begin",
      "select",
      "delete workspaces",
      "select",
      "delete memberships",
      "delete users",
      "commit",
    ]);
    expect(p.released()).toBe(1);
  });

  it("accepts accounts that own nothing, and an empty list", async () => {
    await expect(deleteAccounts(fakePool({}, { users: 1 }).pool, ["a"])).resolves.toBeUndefined();
    await expect(deleteAccounts(fakePool({}, {}).pool, [])).resolves.toBeUndefined();
  });

  it("rejects a missing user, rolls back and releases, naming counts only", async () => {
    const p = fakePool({ workspaces: 1 }, { workspaces: 1, users: 1 });
    const error = await deleteAccounts(p.pool, ["secret-id-1", "secret-id-2"]).catch(
      (e: unknown) => e,
    );
    expect(String(error)).toContain("users deleted 1 of 2");
    expect(String(error)).not.toContain("secret-id");
    expect(p.log.at(-1)).toBe("rollback");
    expect(p.released()).toBe(1);
  });

  it("rejects a dependent delete that removes fewer rows than were counted", async () => {
    const p = fakePool({ workspaces: 3 }, { workspaces: 0 });
    await expect(deleteAccounts(p.pool, ["a"])).rejects.toThrow("workspaces deleted 0 of 3");
    expect(p.log).not.toContain("commit");
  });

  it("releases the connection and surfaces the original error when a query fails", async () => {
    let released = 0;
    const boom = new Error("boom");
    const pool = {
      connect: async (): Promise<CleanupClient> => ({
        query: async (text) => {
          if (text !== "begin") throw boom;
          return { rowCount: null, rows: [] };
        },
        release: () => {
          released++;
        },
      }),
    };
    await expect(deleteAccounts(pool, ["a"])).rejects.toBe(boom);
    expect(released).toBe(1);
  });
});
