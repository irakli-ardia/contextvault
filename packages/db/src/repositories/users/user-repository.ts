import { parseEmail, parseUserId, type UserRepository } from "@contextvault/domain";
import { eq } from "drizzle-orm";
import type { Executor } from "../../client";
import { users } from "../../schema/index";

export function createUserRepository(executor: Executor): UserRepository {
  return {
    async findById(id) {
      const [row] = await executor
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return row === undefined ? null : { id: parseUserId(row.id), email: parseEmail(row.email) };
    },
  };
}
