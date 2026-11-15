import { describe, expect, it } from "vitest";
import { seedTenants, TENANT_B_CHUNKS } from "./keyword-experiment-seed.mjs";

describe("seedTenants", () => {
  it("leaves statistics to the owner: the fixture role runs no VACUUM or ANALYZE", async () => {
    const statements = [];
    const fixture = {
      query: async (sql) => {
        statements.push(sql);
        return { rows: [{ id: "c1" }] };
      },
    };
    const tenants = await seedTenants(fixture, 10);
    expect(tenants).toHaveLength(2);
    expect(statements.filter((s) => /\b(vacuum|analyze)\b/i.test(s))).toEqual([]);
    expect(TENANT_B_CHUNKS).toBe(1000);
  });
});
