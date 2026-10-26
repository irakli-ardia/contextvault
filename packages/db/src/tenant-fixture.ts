import { randomBytes, randomUUID } from "node:crypto";
import { loadDatabaseEnv, loadMigrationEnv } from "@contextvault/config";
import { parseUserId, parseWorkspaceId, type UserId, type WorkspaceId } from "@contextvault/domain";
import pg from "pg";
import { createPersistence, type Persistence } from "./persistence";
import { postgresErrorCode } from "./repositories/workspaces/postgres-error";

// Real-Postgres fixture for integration tests. `owner` seeds users and cleans up (the migration
// role bypasses RLS as a superuser); everything under test goes through the application role.
export interface TenantFixture {
  readonly owner: pg.Pool;
  readonly persistence: Persistence;
  seedUser(): Promise<UserId>;
  createWorkspace(userId: UserId, name?: string): Promise<WorkspaceId>;
  /** Owner-seeded credential; returns the (fake) stored hash. */
  seedCredential(userId: UserId, passwordHash?: string): Promise<string>;
  /** Owner-seeded session; returns its id and token hash (hex). */
  seedSession(
    userId: UserId,
    options?: { expiresAt?: Date; revokedAt?: Date },
  ): Promise<{ id: string; hash: string }>;
  /** Raw SQL as the application role in one transaction, with the given context settings. */
  queryAs<T extends pg.QueryResultRow>(
    context: {
      userId?: string;
      workspaceId?: string;
      loginEmail?: string;
      sessionTokenHash?: string;
    } | null,
    text: string,
    values?: unknown[],
  ): Promise<T[]>;
  close(): Promise<void>;
}

export function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  return work.then(
    () => undefined,
    (error: unknown) => postgresErrorCode(error),
  );
}

export function createTenantFixture(poolSize = 4): TenantFixture {
  const appUrl = loadDatabaseEnv().DATABASE_URL;
  const owner = new pg.Pool({
    connectionString: loadMigrationEnv().DATABASE_MIGRATION_URL,
    max: 2,
  });
  const rawApp = new pg.Pool({ connectionString: appUrl, max: poolSize });
  const persistence = createPersistence({ connectionString: appUrl, poolSize });
  const users: string[] = [];

  return {
    owner,
    persistence,
    async seedUser() {
      const id = randomUUID();
      await owner.query("insert into users (id, email) values ($1, $2)", [
        id,
        `${id}@test.invalid`,
      ]);
      users.push(id);
      return parseUserId(id);
    },
    async createWorkspace(userId, name = "Test workspace") {
      const id = parseWorkspaceId(randomUUID());
      await persistence.unitOfWork.run({ userId }, (r) =>
        r.workspaces.insert({ id, name }, userId),
      );
      return id;
    },
    async seedCredential(userId, passwordHash) {
      const hash =
        passwordHash ?? `$argon2id$v=19$m=64,t=1,p=1$${randomBytes(16).toString("base64url")}$fake`;
      await owner.query("insert into user_credentials (user_id, password_hash) values ($1, $2)", [
        userId,
        hash,
      ]);
      return hash;
    },
    async seedSession(userId, options = {}) {
      const id = randomUUID();
      const hash = randomBytes(32).toString("hex");
      // created_at is backdated so an already-expired session still satisfies expires_at > created_at.
      await owner.query(
        `insert into sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at)
         values ($1, $2, decode($3, 'hex'), now() - interval '30 days', now() - interval '30 days',
                 $4, $5)`,
        [
          id,
          userId,
          hash,
          options.expiresAt ?? new Date(Date.now() + 86_400_000),
          options.revokedAt ?? null,
        ],
      );
      return { id, hash };
    },
    async queryAs(context, text, values) {
      const client = await rawApp.connect();
      try {
        await client.query("begin");
        if (context !== null) {
          await client.query(
            `select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true),
              set_config('app.login_email', $3, true), set_config('app.session_token_hash', $4, true)`,
            [
              context.userId ?? "",
              context.workspaceId ?? "",
              context.loginEmail ?? "",
              context.sessionTokenHash ?? "",
            ],
          );
        }
        const result = await client.query(text, values);
        await client.query("commit");
        return result.rows;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await owner.query("delete from workspaces where created_by = any($1)", [users]);
      await owner.query("delete from memberships where user_id = any($1)", [users]);
      await owner.query("delete from users where id = any($1)", [users]);
      await Promise.all([persistence.close(), rawApp.end(), owner.end()]);
    },
  };
}
