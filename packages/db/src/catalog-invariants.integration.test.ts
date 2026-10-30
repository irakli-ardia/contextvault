import { readFileSync } from "node:fs";
import { loadBootstrapEnv, loadDatabaseEnv, loadWorkerDatabaseEnv } from "@contextvault/config";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

// Catalog-level security invariants, discovered from pg_catalog so a new table is checked without
// editing this file. What it guarantees about the application role: not privileged, no memberships,
// owns nothing, cannot create objects, holds exactly the reviewed grants (table AND column level,
// PUBLIC included via the effective-privilege functions), and every app table has RLS on and
// forced. What it does not: policy predicates (behavioural RLS tests own that), the owner and
// fixture roles (role-model tests own those), extension-owned functions, or live data.

// Not RLS-checked; the application role must hold nothing on it (asserted by the grant list).
const RLS_EXEMPT = ["drizzle.__drizzle_migrations"]; // migrator bookkeeping, no tenant data
// RLS must stay enabled, and the application role stays bound by it (it is not the owner, and every
// policy is TO it). FORCE is omitted only because the owner role must write these two tables to
// create accounts (migration 0004, threat model "Tenant isolation"); FORCE would block that owner
// path without adding anything for the application role. Any other table must be forced.
const FORCE_EXEMPT = ["public.users", "public.user_credentials"];

// The reviewed application-role privileges, table → grants. "PRIV" is table-level; "PRIV(col)" is
// column-only. A table or sequence missing here must have no grants, so a new table fails closed
// until a reviewer lists what it may do.
const EXPECTED_GRANTS: Record<string, readonly string[]> = {
  "public.workspaces": ["SELECT", "INSERT"],
  "public.memberships": ["SELECT", "INSERT"],
  "public.users": ["SELECT"],
  "public.user_credentials": ["SELECT", "UPDATE(password_hash)", "UPDATE(password_changed_at)"],
  // token_hash is deliberately unreadable: the policies compare it without the caller holding SELECT.
  "public.sessions": [
    "INSERT",
    "DELETE",
    ...["id", "user_id", "created_at", "last_seen_at", "expires_at", "revoked_at"].map(
      (c) => `SELECT(${c})`,
    ),
    "UPDATE(last_seen_at)",
    "UPDATE(revoked_at)",
  ],
  "public.documents": ["SELECT", "INSERT"],
  "public.document_versions": ["SELECT", "INSERT"],
  "public.pending_uploads": ["SELECT", "INSERT", "DELETE"],
  // Insert only, and not available_at, dispatched_at or created_at: an entry is always due and live.
  "public.outbox": ["id", "workspace_id", "version_id", "kind"].map((c) => `INSERT(${c})`),
};

// The ingestion worker (migration 0008): lifecycle metadata of document_versions only (no storage
// key, no error text), the deleted flag of documents, and the outbox. Same fail-closed rule: a
// table missing here must have no grants for the worker.
const WORKER_EXPECTED_GRANTS: Record<string, readonly string[]> = {
  "public.document_versions": [
    ...[
      "id",
      "workspace_id",
      "document_id",
      "status",
      "lease_generation",
      "attempt",
      "updated_at",
    ].map((c) => `SELECT(${c})`),
    ...[
      "status",
      "lease_generation",
      "attempt",
      "error_stage",
      "error_code",
      "error_retryable",
      "updated_at",
    ].map((c) => `UPDATE(${c})`),
  ],
  "public.documents": ["id", "workspace_id", "deleted_at"].map((c) => `SELECT(${c})`),
  "public.outbox": ["SELECT", "INSERT", "UPDATE(dispatched_at)"],
};

const TABLE_PRIVS = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
];
const COLUMN_PRIVS = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];
const APP_SCHEMAS = `n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%'`;
const flatten = (grants: Record<string, readonly string[]>) =>
  Object.entries(grants).flatMap(([rel, list]) => list.map((g) => `${rel} ${g}`));

type Db = Pick<pg.ClientBase, "query">;
const rows = async <T extends pg.QueryResultRow>(db: Db, text: string, values: unknown[]) =>
  (await db.query<T>(text, values)).rows;

/** Every violation of the policy for `role`, as one readable line each. Empty means compliant. */
async function violations(
  db: Db,
  role: string,
  grants: Record<string, readonly string[]>,
  otherRole: string,
): Promise<string[]> {
  const out: string[] = [];
  const expectedGrants = flatten(grants);

  const [attrs] = await rows<Record<string, boolean>>(
    db,
    "select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication from pg_roles where rolname = $1",
    [role],
  );
  if (attrs === undefined) return [`role ${role} does not exist`];
  for (const [attr, on] of Object.entries(attrs)) if (on) out.push(`role ${role} has ${attr}`);
  const member = await rows<{ r: string }>(
    db,
    `select pg_get_userbyid(roleid) as r from pg_auth_members
     where member = (select oid from pg_roles where rolname = $1)`,
    [role],
  );
  for (const { r } of member) out.push(`role ${role} is a member of ${r}`);

  const rels = await rows<{
    rel: string;
    kind: string;
    rls: boolean;
    forced: boolean;
    owned: boolean;
  }>(
    db,
    `select n.nspname || '.' || c.relname as rel, c.relkind as kind, c.relrowsecurity as rls,
       c.relforcerowsecurity as forced, pg_has_role($1, c.relowner, 'MEMBER') as owned
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where ${APP_SCHEMAS} and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')`,
    [role],
  );
  for (const r of rels) {
    if (r.owned) out.push(`${r.rel} is owned by (or inherited into) ${role}`);
    if (r.kind === "v" || r.kind === "m" || r.kind === "f")
      out.push(`${r.rel} is a view/foreign relation: not covered by RLS, needs a reviewed design`);
    if (r.kind !== "r" && r.kind !== "p") continue;
    if (RLS_EXEMPT.includes(r.rel)) continue;
    if (!r.rls) out.push(`${r.rel} has row level security disabled`);
    if (!r.forced && !FORCE_EXEMPT.includes(r.rel))
      out.push(`${r.rel} has row level security enabled but not FORCEd`);
  }

  const granted = await rows<{ g: string }>(
    db,
    `select n.nspname || '.' || c.relname || ' ' || p as g
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join unnest($2::text[]) p
     where ${APP_SCHEMAS} and c.relkind in ('r', 'p', 'v', 'm', 'f') and has_table_privilege($1, c.oid, p)
     union all
     select n.nspname || '.' || c.relname || ' ' || p
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) p
     where ${APP_SCHEMAS} and c.relkind = 'S' and has_sequence_privilege($1, c.oid, p)
     union all
     select n.nspname || '.' || c.relname || ' ' || p || '(' || a.attname || ')'
     from pg_attribute a join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     cross join unnest($3::text[]) p
     where ${APP_SCHEMAS} and c.relkind in ('r', 'p', 'v', 'm', 'f') and a.attnum > 0
       and not a.attisdropped and has_column_privilege($1, c.oid, a.attnum, p)
       and not has_table_privilege($1, c.oid, p)`,
    [role, TABLE_PRIVS, COLUMN_PRIVS],
  );
  const actual = granted.map((r) => r.g);
  for (const g of actual) if (!expectedGrants.includes(g)) out.push(`unreviewed grant: ${g}`);
  for (const g of expectedGrants) if (!actual.includes(g)) out.push(`reviewed grant missing: ${g}`);

  const publicGrants = await rows<{ g: string }>(
    db,
    `select 'relation ' || n.nspname || '.' || c.relname || ' ' || a.privilege_type as g
     from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
     where ${APP_SCHEMAS} and a.grantee = 0
     union all
     select 'column ' || n.nspname || '.' || c.relname || '(' || t.attname || ') ' || a.privilege_type
     from pg_attribute t join pg_class c on c.oid = t.attrelid
     join pg_namespace n on n.oid = c.relnamespace, aclexplode(t.attacl) a
     where ${APP_SCHEMAS} and a.grantee = 0
     union all
     select 'schema ' || n.nspname || ' ' || a.privilege_type
     from pg_namespace n, aclexplode(n.nspacl) a where ${APP_SCHEMAS} and a.grantee = 0
     union all
     select 'database ' || datname || ' (default ACL or explicit)'
     from pg_database where datname = current_database()
       and (datacl is null or exists (select 1 from aclexplode(datacl) a where a.grantee = 0))`,
    [],
  );
  for (const { g } of publicGrants) out.push(`PUBLIC holds a grant: ${g}`);

  const schemas = await rows<{ name: string; owned: boolean; create: boolean; usage: boolean }>(
    db,
    `select n.nspname as name, pg_has_role($1, n.nspowner, 'MEMBER') as owned,
       has_schema_privilege($1, n.oid, 'CREATE') as create,
       has_schema_privilege($1, n.oid, 'USAGE') as usage
     from pg_namespace n where ${APP_SCHEMAS}`,
    [role],
  );
  for (const s of schemas) {
    if (s.owned) out.push(`schema ${s.name} is owned by ${role}`);
    if (s.create) out.push(`${role} can CREATE in schema ${s.name}`);
    if (s.usage && s.name !== "public") out.push(`${role} has USAGE on schema ${s.name}`);
  }
  const [dbPrivs] = await rows<{ connect: boolean; create: boolean; temp: boolean }>(
    db,
    `select has_database_privilege($1, current_database(), 'CONNECT') as connect,
       has_database_privilege($1, current_database(), 'CREATE') as create,
       has_database_privilege($1, current_database(), 'TEMPORARY') as temp`,
    [role],
  );
  if (dbPrivs?.create) out.push(`${role} can CREATE schemas in the database`);
  if (dbPrivs?.temp) out.push(`${role} can create TEMPORARY tables`);

  const policies = await rows<{ p: string }>(
    db,
    `select schemaname || '.' || tablename || ' ' || policyname as p from pg_policies
     where roles <> array[$1]::name[] and roles <> array[$2]::name[]`,
    [role, otherRole],
  );
  for (const { p } of policies)
    out.push(`policy ${p} is not limited to TO ${role} or ${otherRole}`);

  const definers = await rows<{ f: string }>(
    db,
    `select n.nspname || '.' || p.proname as f from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where ${APP_SCHEMAS} and p.prosecdef and not exists (
       select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`,
    [],
  );
  for (const { f } of definers) out.push(`SECURITY DEFINER function ${f} can bypass RLS`);

  return out;
}

// Privileged catalog reads and rolled-back role probes use the bootstrap connection only; the
// application role under inspection is named by DATABASE_URL, never connected as here.
const bootstrap = new pg.Pool({
  connectionString: loadBootstrapEnv().DATABASE_BOOTSTRAP_URL,
  max: 1,
});
afterAll(() => bootstrap.end());

const roleOf = (url: string) => decodeURIComponent(new URL(url).username);
const appRole = roleOf(loadDatabaseEnv().DATABASE_URL);
const workerRole = roleOf(loadWorkerDatabaseEnv().DATABASE_WORKER_URL);

describe("catalog invariants", () => {
  it("runs against a database with every committed migration applied", async () => {
    const journal: unknown = JSON.parse(
      readFileSync(
        new URL("../../../infra/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    );
    const committed =
      typeof journal === "object" && journal !== null && "entries" in journal
        ? journal.entries
        : undefined;
    if (!Array.isArray(committed)) throw new Error("unreadable migration journal");
    const applied = await bootstrap.query<{ created_at: string }>(
      "select created_at from drizzle.__drizzle_migrations order by id",
    );
    const when = (e: unknown) =>
      typeof e === "object" && e !== null && "when" in e ? Number(e.when) : Number.NaN;
    expect(applied.rows.map((r) => Number(r.created_at))).toEqual(committed.map(when));
  });

  it("finds the application tables it is meant to protect (guards against an empty catalog query)", async () => {
    const found = await bootstrap.query<{ rel: string }>(
      `select n.nspname || '.' || c.relname as rel from pg_class c
       join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname = 'public'`,
    );
    const names = found.rows.map((r) => r.rel);
    expect(names.sort()).toEqual(Object.keys(EXPECTED_GRANTS).sort());
    expect(FORCE_EXEMPT.filter((t) => !names.includes(t))).toEqual([]);
  });

  it("holds for the application role", async () => {
    expect(await violations(bootstrap, appRole, EXPECTED_GRANTS, workerRole)).toEqual([]);
  });

  it("holds for the worker role", async () => {
    expect(await violations(bootstrap, workerRole, WORKER_EXPECTED_GRANTS, appRole)).toEqual([]);
  });

  it("pins the worker role's policies to exactly the reviewed list", async () => {
    const { rows } = await bootstrap.query<{ p: string }>(
      `select tablename || '.' || policyname as p from pg_policies
       where roles = array[$1]::name[] order by 1`,
      [workerRole],
    );
    expect(rows.map((r) => r.p)).toEqual([
      "document_versions.document_versions_worker_discover",
      "document_versions.document_versions_worker_update",
      "documents.documents_worker_select",
      "outbox.outbox_worker_discover",
      "outbox.outbox_worker_insert",
      "outbox.outbox_worker_mark",
    ]);
  });
});

// Each probe breaks one rule inside a transaction on a dedicated owner connection, and the
// transaction is always rolled back. Probes create new objects or roles instead of altering existing
// ones, so no lock is taken on a table other tests use and nothing is ever visible to other sessions.
describe("catalog invariants detect violations", () => {
  const probeTable = (extra: string[] = []) => [
    "create table public.probe (id int, secret text)",
    "alter table public.probe enable row level security",
    "alter table public.probe force row level security",
    ...extra,
  ];
  const probes: { name: string; setup: string[]; expect: string; role?: string }[] = [
    {
      name: "a new table without RLS",
      setup: ["create table public.probe (id int)"],
      expect: "public.probe has row level security disabled",
    },
    {
      name: "a table with RLS enabled but not forced",
      setup: [
        "create table public.probe (id int)",
        "alter table public.probe enable row level security",
      ],
      expect: "public.probe has row level security enabled but not FORCEd",
    },
    {
      name: "a compliant new table nobody has reviewed grants for",
      setup: probeTable(["grant select on public.probe to ROLE"]),
      expect: "unreviewed grant: public.probe SELECT",
    },
    {
      name: "TRUNCATE on a new table",
      setup: probeTable(["grant truncate on public.probe to ROLE"]),
      expect: "unreviewed grant: public.probe TRUNCATE",
    },
    {
      name: "REFERENCES on a new table",
      setup: probeTable(["grant references on public.probe to ROLE"]),
      expect: "unreviewed grant: public.probe REFERENCES",
    },
    {
      name: "a column-only grant",
      setup: probeTable(["grant select (secret) on public.probe to ROLE"]),
      expect: "unreviewed grant: public.probe SELECT(secret)",
    },
    {
      name: "a grant to PUBLIC",
      setup: probeTable(["grant select on public.probe to public"]),
      expect: "PUBLIC holds a grant: relation public.probe SELECT",
    },
    {
      name: "a column grant to PUBLIC",
      setup: probeTable(["grant select (secret) on public.probe to public"]),
      expect: "PUBLIC holds a grant: column public.probe(secret) SELECT",
    },
    {
      name: "a policy that applies to PUBLIC",
      setup: probeTable(["create policy probe_all on public.probe for select using (true)"]),
      expect: "policy public.probe probe_all is not limited to TO",
    },
    {
      name: "a table owned by the application role",
      setup: probeTable(["alter table public.probe owner to ROLE"]),
      expect: "public.probe is owned by (or inherited into)",
    },
    {
      name: "CREATE on a schema",
      setup: ["create schema probe_schema", "grant create on schema probe_schema to ROLE"],
      expect: "can CREATE in schema probe_schema",
    },
    {
      name: "USAGE on an unreviewed schema",
      setup: ["create schema probe_schema", "grant usage on schema probe_schema to ROLE"],
      expect: "has USAGE on schema probe_schema",
    },
    {
      name: "a view",
      setup: ["create view public.probe_v as select 1 as x"],
      expect: "public.probe_v is a view",
    },
    {
      name: "a sequence grant",
      setup: [
        "create sequence public.probe_seq",
        "grant usage on sequence public.probe_seq to ROLE",
      ],
      expect: "unreviewed grant: public.probe_seq USAGE",
    },
    {
      name: "a SECURITY DEFINER function",
      setup: [
        "create function public.probe_fn() returns int language sql security definer as 'select 1'",
      ],
      expect: "SECURITY DEFINER function public.probe_fn",
    },
    ...(
      [
        ["superuser", "rolsuper"],
        ["createrole", "rolcreaterole"],
        ["createdb", "rolcreatedb"],
        ["bypassrls", "rolbypassrls"],
        ["replication", "rolreplication"],
      ] as const
    ).map(([attr, column]) => ({
      name: `a role with ${attr}`,
      setup: [`alter role ROLE ${attr}`],
      expect: `has ${column}`,
    })),
    {
      name: "a role membership",
      setup: ["grant pg_read_all_data to ROLE"],
      expect: "is a member of pg_read_all_data",
    },
  ];

  it.each(probes)("fails on $name", async ({ setup, expect: expected }) => {
    const client = await bootstrap.connect();
    try {
      await client.query("begin");
      // A throwaway role stands in for the application role: the real one is never altered.
      const probeRole = "probe_app_role";
      await client.query(`create role ${probeRole} nologin`);
      for (const sql of setup) await client.query(sql.replaceAll("ROLE", probeRole));
      const found = await violations(client, probeRole, EXPECTED_GRANTS, "contextvault_worker");
      expect(
        found.some((v) => v.includes(expected)),
        found.join("\n"),
      ).toBe(true);
    } finally {
      await client.query("rollback").finally(() => client.release());
    }
  });

  it("leaves no probe object behind", async () => {
    const left = await bootstrap.query(
      "select 1 from pg_class where relname = 'probe' union all select 1 from pg_roles where rolname = 'probe_app_role'",
    );
    expect(left.rows).toHaveLength(0);
  });
});
