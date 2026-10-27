import { randomBytes, randomUUID } from "node:crypto";
import { loadDatabaseEnv, loadFixtureEnv } from "@contextvault/config";
import { parseUserId, parseWorkspaceId, type UserId, type WorkspaceId } from "@contextvault/domain";
import pg from "pg";
import { createPersistence, type Persistence } from "./persistence";
import { postgresErrorCode } from "./repositories/workspaces/postgres-error";

// Real-Postgres fixture for integration tests. `fixture` seeds users and cleans up on the explicit
// DATABASE_FIXTURE_URL (no fallback to any other URL); everything under test goes through the
// application role.
export interface TenantFixture {
  readonly fixture: pg.Pool;
  readonly persistence: Persistence;
  seedUser(): Promise<UserId>;
  createWorkspace(userId: UserId, name?: string): Promise<WorkspaceId>;
  /** Fixture-seeded credential; returns the (fake) stored hash. */
  seedCredential(userId: UserId, passwordHash?: string): Promise<string>;
  /** Fixture-seeded session; returns its id and token hash (hex). */
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

// Async so the role check completes before any caller holds the pool: a fixture that cannot see
// every row would seed and clean up silently wrong, so it must be a superuser or BYPASSRLS. The
// message is fixed (never echoes connection data) and a refused pool is closed before throwing.
export async function createTenantFixture(poolSize = 4): Promise<TenantFixture> {
  const appUrl = loadDatabaseEnv().DATABASE_URL;
  const fixture = new pg.Pool({ connectionString: loadFixtureEnv().DATABASE_FIXTURE_URL, max: 2 });
  try {
    const { rows } = await fixture.query<{ ok: boolean }>(
      "select rolsuper or rolbypassrls as ok from pg_roles where rolname = current_user",
    );
    if (rows[0]?.ok !== true) {
      throw new Error("FIXTURE_ROLE_CANNOT_SEE_ALL: DATABASE_FIXTURE_URL needs a BYPASSRLS role");
    }
  } catch (error) {
    await fixture.end();
    throw error;
  }
  const rawApp = new pg.Pool({ connectionString: appUrl, max: poolSize });
  const persistence = createPersistence({ connectionString: appUrl, poolSize });
  const users: string[] = [];

  return {
    fixture,
    persistence,
    async seedUser() {
      const id = randomUUID();
      await fixture.query("insert into users (id, email) values ($1, $2)", [
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
      await fixture.query("insert into user_credentials (user_id, password_hash) values ($1, $2)", [
        userId,
        hash,
      ]);
      return hash;
    },
    async seedSession(userId, options = {}) {
      const id = randomUUID();
      const hash = randomBytes(32).toString("hex");
      // created_at is backdated so an already-expired session still satisfies expires_at > created_at.
      await fixture.query(
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
      try {
        await fixture.query("delete from workspaces where created_by = any($1)", [users]);
        await fixture.query("delete from memberships where user_id = any($1)", [users]);
        await fixture.query("delete from users where id = any($1)", [users]);
      } finally {
        await Promise.all([persistence.close(), rawApp.end(), fixture.end()]);
      }
    },
  };
}
