import { sql } from "drizzle-orm";
import type { Database } from "./client";

export class PrivilegeCheckFailed extends Error {
  override readonly name = "PrivilegeCheckFailed";
}

// The application role must be bound by RLS: not a superuser, not BYPASSRLS, and not an owner of
// any table (an owner is exempt from non-forced policies). Messages never carry connection data.
export async function assertLeastPrivilege(db: Database): Promise<void> {
  const result = await db.execute<{ superuser: boolean; bypass: boolean; owns: boolean }>(sql`
    select r.rolsuper as superuser, r.rolbypassrls as bypass,
      exists (select 1 from pg_class c where c.relowner = r.oid and c.relkind in ('r', 'p')) as owns
    from pg_roles r where r.rolname = current_user`);
  const row = result.rows[0];
  if (row === undefined) throw new PrivilegeCheckFailed("Current database role not found");
  if (row.superuser || row.bypass || row.owns) {
    throw new PrivilegeCheckFailed(
      "Database role is not least-privilege (superuser, BYPASSRLS, or owner)",
    );
  }
}
