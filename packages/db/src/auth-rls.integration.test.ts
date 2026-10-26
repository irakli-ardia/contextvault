import type { UserId } from "@contextvault/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenantFixture, sqlState } from "./tenant-fixture";

// The thirteen probes from the M1.2 architecture spike, against the real application role.
// P1-P13 name them; the tests after P13 are the extra properties the plan §11 asks for.
const fx = createTenantFixture(1);
afterAll(() => fx.close());

interface Account {
  id: UserId;
  email: string;
  session: { id: string; hash: string };
}
async function account(): Promise<Account> {
  const id = await fx.seedUser();
  await fx.seedCredential(id);
  return { id, email: `${id}@test.invalid`, session: await fx.seedSession(id) };
}

let a: Account;
let b: Account;
beforeAll(async () => {
  [a, b] = [await account(), await account()];
});

const counts = (context: Parameters<typeof fx.queryAs>[0]) =>
  fx.queryAs<{ users: string; credentials: string; sessions: string }>(
    context,
    `select (select count(*) from users) as users,
            (select count(*) from user_credentials) as credentials,
            (select count(*) from sessions) as sessions`,
  );
const none = [{ users: "0", credentials: "0", sessions: "0" }];

describe("fail closed", () => {
  it("P1 no settings: zero rows on all three tables", async () => {
    expect(await counts(null)).toEqual(none);
  });

  it("P2 empty settings: zero rows on all three tables", async () => {
    expect(await counts({})).toEqual(none);
  });

  it.each([
    ["uppercase hex", () => a.session.hash.toUpperCase()],
    ["too short", () => a.session.hash.slice(0, 62)],
    ["too long", () => `${a.session.hash}00`],
    ["not hex", () => "zz"],
    ["0x prefix", () => `0x${a.session.hash.slice(2)}`],
    ["padded", () => ` ${a.session.hash}`],
    ["two hashes", () => `${a.session.hash},${b.session.hash}`],
  ])("P6 malformed session proof (%s) matches nothing and does not error", async (_n, value) => {
    expect(await counts({ sessionTokenHash: value() })).toEqual(none);
  });

  it.each(["' or '1'='1", "%", "_", "%@%", "", " ", "null"])(
    "P4 hostile login proof %j matches nothing",
    async (value) => {
      expect(await counts({ loginEmail: value })).toEqual(none);
    },
  );

  it("P4 case variants, padding and joined emails match nothing", async () => {
    for (const value of [
      a.email.toUpperCase(),
      ` ${a.email}`,
      `${a.email} `,
      `${a.email},${b.email}`,
      `${a.email}|${b.email}`,
    ]) {
      expect(await counts({ loginEmail: value })).toEqual(none);
    }
  });
});

describe("login proof", () => {
  it("P3 exposes exactly the presented user and its credential, and no sessions", async () => {
    expect(await counts({ loginEmail: a.email })).toEqual([
      { users: "1", credentials: "1", sessions: "0" },
    ]);
    const rows = await fx.queryAs<{ id: string }>({ loginEmail: a.email }, "select id from users");
    expect(rows).toEqual([{ id: a.id }]);
  });

  it("updates only the presented user's hash and password_changed_at", async () => {
    const update = (email: string, id: string) =>
      fx.queryAs(
        { loginEmail: email },
        "update user_credentials set password_hash = 'rehashed', password_changed_at = now() where user_id = $1 returning user_id",
        [id],
      );
    expect(await update(a.email, b.id)).toHaveLength(0);
    expect(await update(a.email, a.id)).toHaveLength(1);
    const {
      rows: [row],
    } = await fx.owner.query<{ password_hash: string }>(
      "select password_hash from user_credentials where user_id = $1",
      [b.id],
    );
    expect(row?.password_hash).not.toBe("rehashed");
  });

  it("cannot change user_id or created_at, and cannot read sessions or insert credentials", async () => {
    const login = { loginEmail: a.email };
    expect(
      await sqlState(fx.queryAs(login, "update user_credentials set user_id = $1", [b.id])),
    ).toBe("42501");
    expect(
      await sqlState(fx.queryAs(login, "update user_credentials set created_at = now()")),
    ).toBe("42501");
    expect(await sqlState(fx.queryAs(login, "delete from user_credentials"))).toBe("42501");
    expect(
      await sqlState(
        fx.queryAs(
          login,
          "insert into user_credentials (user_id, password_hash) values (gen_random_uuid(), 'x')",
        ),
      ),
    ).toBe("42501");
  });
});

describe("session proof", () => {
  it("P5 exposes exactly one session", async () => {
    const rows = await fx.queryAs<{ id: string }>(
      { sessionTokenHash: a.session.hash },
      "select id from sessions",
    );
    expect(rows).toEqual([{ id: a.session.id }]);
  });

  it("P7 exposes no user and no credential", async () => {
    expect(await counts({ sessionTokenHash: a.session.hash })).toEqual([
      { users: "0", credentials: "0", sessions: "1" },
    ]);
  });

  it("P11 cannot change id, user_id, token_hash, created_at or expires_at, even with a valid proof", async () => {
    const proof = { sessionTokenHash: a.session.hash };
    for (const assignment of [
      "id = gen_random_uuid()",
      `user_id = '${b.id}'`,
      "token_hash = decode(repeat('00', 32), 'hex')",
      "created_at = now()",
      "expires_at = now() + interval '1000 days'",
    ]) {
      expect(await sqlState(fx.queryAs(proof, `update sessions set ${assignment}`))).toBe("42501");
    }
  });

  it("may update last_seen_at and revoked_at of its one row only", async () => {
    const rows = await fx.queryAs(
      { sessionTokenHash: b.session.hash },
      "update sessions set last_seen_at = now(), revoked_at = now() returning id",
    );
    expect(rows).toEqual([{ id: b.session.id }]);
    await fx.owner.query("update sessions set revoked_at = null where id = $1", [b.session.id]);
  });

  it("cannot read token_hash back, by name or by star", async () => {
    const proof = { sessionTokenHash: a.session.hash };
    expect(await sqlState(fx.queryAs(proof, "select token_hash from sessions"))).toBe("42501");
    expect(await sqlState(fx.queryAs(proof, "select * from sessions"))).toBe("42501");
    expect(
      await sqlState(fx.queryAs(proof, "select id from sessions where token_hash is not null")),
    ).toBe("42501");
  });
});

describe("user context", () => {
  it("P8 sees only its own sessions and no credentials", async () => {
    expect(await counts({ userId: a.id })).toEqual([
      { users: "1", credentials: "0", sessions: "1" },
    ]);
    const rows = await fx.queryAs<{ id: string }>({ userId: a.id }, "select id from sessions");
    expect(rows).toEqual([{ id: a.session.id }]);
  });

  it("P9 cannot update or delete another user's session", async () => {
    const ctx = { userId: a.id };
    expect(
      await fx.queryAs(ctx, "update sessions set revoked_at = now() where id = $1 returning id", [
        b.session.id,
      ]),
    ).toHaveLength(0);
    expect(
      await fx.queryAs(ctx, "delete from sessions where id = $1 returning id", [b.session.id]),
    ).toHaveLength(0);
    const {
      rows: [row],
    } = await fx.owner.query("select 1 from sessions where id = $1 and revoked_at is null", [
      b.session.id,
    ]);
    expect(row).toBeDefined();
  });

  it("P10 cannot insert a session for another user", async () => {
    expect(
      await sqlState(
        fx.queryAs(
          { userId: a.id },
          `insert into sessions (id, user_id, token_hash, expires_at)
           values (gen_random_uuid(), $1, decode(repeat('ab', 32), 'hex'), now() + interval '1 day')`,
          [b.id],
        ),
      ),
    ).toBe("42501");
  });

  it("deletes only its own dead sessions, never a live one", async () => {
    const live = a.session.id;
    const dead = await fx.seedSession(a.id, { revokedAt: new Date() });
    const expired = await fx.seedSession(a.id, { expiresAt: new Date(Date.now() - 1000) });
    const deleted = await fx.queryAs<{ id: string }>(
      { userId: a.id },
      "delete from sessions returning id",
    );
    expect(deleted.map((r) => r.id).toSorted()).toEqual([dead.id, expired.id].toSorted());
    const {
      rows: [row],
    } = await fx.owner.query("select 1 from sessions where id = $1", [live]);
    expect(row).toBeDefined();
  });
});

describe("privileges and connection reuse", () => {
  it("P12 the application role cannot create accounts or credentials", async () => {
    const id = a.id;
    expect(
      await sqlState(
        fx.queryAs(
          { userId: id },
          "insert into users (id, email) values (gen_random_uuid(), 'x@test.invalid')",
        ),
      ),
    ).toBe("42501");
    expect(
      await sqlState(
        fx.queryAs(
          { loginEmail: a.email },
          "insert into user_credentials (user_id, password_hash) values ($1, 'x')",
          [id],
        ),
      ),
    ).toBe("42501");
  });

  it("P13 proofs are transaction-local: the next transaction on the same connection sees nothing", async () => {
    await fx.queryAs(
      { loginEmail: a.email, sessionTokenHash: a.session.hash, userId: a.id },
      "select 1",
    );
    const settings = await fx.queryAs(
      null,
      `select current_setting('app.login_email', true) as e,
              current_setting('app.session_token_hash', true) as s,
              current_setting('app.user_id', true) as u`,
    );
    expect(settings).toEqual([{ e: "", s: "", u: "" }]);
    expect(await counts(null)).toEqual(none);
    await expect(
      fx.queryAs({ loginEmail: a.email, sessionTokenHash: a.session.hash }, "select 1/0"),
    ).rejects.toThrow();
    expect(await counts(null)).toEqual(none);
  });

  it("row security is enabled on both tables and forced on sessions", async () => {
    const rows = await fx.queryAs(
      null,
      "select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('sessions','user_credentials') order by relname",
    );
    expect(rows).toEqual([
      { relname: "sessions", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "user_credentials", relrowsecurity: true, relforcerowsecurity: false },
    ]);
  });

  it("the application role has no DDL, TRUNCATE, or PUBLIC grants on the new tables", async () => {
    for (const statement of [
      "truncate sessions",
      "truncate user_credentials",
      "alter table sessions disable row level security",
      "drop table user_credentials",
    ]) {
      expect(await sqlState(fx.queryAs(null, statement))).toBe("42501");
    }
    const {
      rows: [row],
    } = await fx.owner.query<{ n: string }>(
      `select count(*) as n from information_schema.table_privileges
       where table_name in ('sessions','user_credentials') and grantee = 'PUBLIC'`,
    );
    expect(row?.n).toBe("0");
  });
});
