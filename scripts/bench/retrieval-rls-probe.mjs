#!/usr/bin/env node
// Read-only catalog facts for the GIN-index question (docs/retrieval-performance.md): are the
// operators and functions of the keyword statement leakproof, and under which roles and policies
// do the retrieval tables run. Catalog metadata does NOT say whether the planner would use an
// index under row-level security; that needs EXPLAIN as the application role on a throwaway index.
//
//   CV_TEST_ENV_DIR=<dir> node scripts/test-stack/with-test-stack.mjs node scripts/bench/retrieval-rls-probe.mjs
//
// One READ ONLY transaction per connection; it creates and changes nothing and prints no URL.

import { createRequire } from "node:module";
import { loadProduction } from "./orphan-explain.mjs";
import { assertStackEnv, assertStackIdentity } from "./retrieval-guard.mjs";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
// The driver belongs to packages/db; a variable keeps the root from declaring it.
const driver = "pg";
const { Client } = require(driver);

const TABLES = ["chunks", "chunk_embeddings", "documents", "document_versions", "memberships"];
const QUERIES = {
  role: `select current_user as name, r.rolsuper, r.rolbypassrls, r.rolinherit
         from pg_roles r where r.rolname = current_user`,
  leakproof: `select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proleakproof
              from pg_proc p where p.proname in ('ts_match_vq', 'ts_match_qv', 'ts_rank_cd',
                'to_tsvector', 'websearch_to_tsquery') and p.pronamespace = 'pg_catalog'::regnamespace
              order by 1, 2`,
  operator: `select o.oprname, o.oprleft::regtype::text as left_type, o.oprright::regtype::text as right_type,
                    p.proname as implementation, p.proleakproof
             from pg_operator o join pg_proc p on p.oid = o.oprcode
             where o.oprname = '@@' and o.oprleft in ('tsvector'::regtype, 'tsquery'::regtype)`,
  tables: `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
                  pg_get_userbyid(c.relowner) as owner
           from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($1)
           order by 1`,
  policies: `select tablename, policyname, cmd, roles, qual from pg_policies
             where schemaname = 'public' and tablename = any($1) order by 1, 2`,
  indexes: `select tablename, indexname, indexdef from pg_indexes
            where schemaname = 'public' and tablename in ('chunks', 'chunk_embeddings') order by 1, 2`,
};

async function facts(client, label) {
  await client.query("begin read only");
  try {
    const out = { connection: label };
    for (const [key, text] of Object.entries(QUERIES)) {
      const params = key === "tables" || key === "policies" ? [TABLES] : [];
      out[key] = (await client.query(text, params)).rows;
    }
    return out;
  } finally {
    await client.query("rollback");
  }
}

// biome-ignore lint/style/noProcessEnv: the guard re-checks what the stack wrapper verified
const { CV_TEST_STACK_VERIFIED: verified, CV_TEST_DB_MARKER: marker } = process.env;
const prod = await loadProduction({ name: "retrieval-sql" });
const appUrl = prod.loadDatabaseEnv().DATABASE_URL;
const fixtureUrl = prod.loadFixtureEnv().DATABASE_FIXTURE_URL;
assertStackEnv({ verified, marker, appUrl, fixtureUrl });
const report = [];
for (const [label, url] of [
  ["application role", appUrl],
  ["fixture role", fixtureUrl],
]) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertStackIdentity(client, marker);
    report.push(await facts(client, label));
  } finally {
    await client.end();
  }
}
console.log(JSON.stringify(report, null, 2));
