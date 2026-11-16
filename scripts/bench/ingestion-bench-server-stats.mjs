// Optional PostgreSQL statement statistics (pg_stat_statements) for the ingestion benchmark.
//
// Privileged access is confined to one place: a channel that runs a fixed list of statements as the
// container's bootstrap superuser over its local socket (`docker exec`, no TCP superuser exists).
// The channel is built only from this invocation's own container spec and the inspect record taken
// when the container was accepted, and it re-checks the exact container identity before every
// statement. The extension lives in its own schema, which no application role can use, so no
// grant, role or policy changes.
//
// What the figures are: PostgreSQL executor time per statement shape, aggregated over a scenario.
// Not per transaction or per activation, no planning time (track_planning is off), no parse, bind,
// driver, network or event-loop time. Client-observed times are never adjusted by these.

import { INGESTION } from "./ingestion-bench-infra.mjs";
import { clientCounts, parseLockWaits, summarize } from "./ingestion-bench-server-stats-rules.mjs";
import { assertContainerSafe, inspectContainer } from "./keyword-experiment-container.mjs";

export const SERVER_SETTINGS = {
  shared_preload_libraries: "pg_stat_statements",
  "pg_stat_statements.max": "10000",
  "pg_stat_statements.track": "top",
  "pg_stat_statements.track_utility": "on",
  "pg_stat_statements.track_planning": "off",
  log_lock_waits: "on",
  deadlock_timeout: "100ms",
};
/** Arguments after the image: the server starts with the library preloaded, nothing is restarted. */
export const SERVER_ARGS = [
  "postgres",
  ...Object.entries(SERVER_SETTINGS).flatMap(([name, value]) => ["-c", `${name}=${value}`]),
];

const ROLES = [
  "contextvault_app",
  "contextvault_worker",
  "contextvault_owner",
  "contextvault_fixture",
];
const SETTING_SQL = Object.keys(SERVER_SETTINGS)
  .map((name) => `'${name}', current_setting('${name}')`)
  .join(", ");
const COUNTERS = [
  "calls",
  "rows",
  "shared_blks_hit",
  "shared_blks_read",
  "shared_blks_dirtied",
  "shared_blks_written",
  "wal_records",
  "wal_fpi",
];
const camel = (s) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase());

// Every statement the channel will run. Constants: no value from a result, a flag or a file is
// ever interpolated into them. The read keeps worker and app rows of this database only, hands
// back the normalized text for classification only (never stored; a statement longer than 1,200
// characters is cut to its first and last 600, which keeps both ends that the rules match on) and
// no query id.
export const SQL = {
  marker:
    "select json_build_object('database', current_database(), 'marker', shobj_description(d.oid, 'pg_database'))::text from pg_database d where d.datname = current_database()",
  install:
    "create schema bench_stats;\ncreate extension pg_stat_statements with schema bench_stats;",
  verify: `select json_build_object(
    'superuser', (select rolsuper from pg_roles where rolname = current_user),
    'settings', json_build_object(${SETTING_SQL}),
    'extensionSchema', (select extnamespace::regnamespace::text from pg_extension where extname = 'pg_stat_statements'),
    'dealloc', (select dealloc from bench_stats.pg_stat_statements_info),
    'roles', (select json_agg(json_build_object('role', r.rolname, 'super', r.rolsuper,
        'bypassRls', r.rolbypassrls,
        'schemaUsage', has_schema_privilege(r.oid, 'bench_stats', 'usage'),
        'canReset', exists (select 1 from pg_proc p where p.pronamespace = 'bench_stats'::regnamespace
          and p.proname = 'pg_stat_statements_reset' and has_function_privilege(r.oid, p.oid, 'execute')))
        order by r.rolname) from pg_roles r where r.rolname in (${ROLES.map((r) => `'${r}'`).join(", ")}))
  )::text`,
  reset: "select bench_stats.pg_stat_statements_reset()",
  read: `select json_build_object(
    'info', (select json_build_object('dealloc', dealloc, 'statsReset', stats_reset) from bench_stats.pg_stat_statements_info),
    'rows', (select coalesce(json_agg(json_build_object('role', r.rolname,
        'query', case when length(c.q) <= 1200 then c.q else left(c.q, 600) || ' ' || right(c.q, 600) end,
        'totalExecMs', s.total_exec_time, 'minExecMs', s.min_exec_time, 'maxExecMs', s.max_exec_time,
        'stddevExecMs', s.stddev_exec_time, 'walBytes', s.wal_bytes::float8,
        ${COUNTERS.map((c) => `'${camel(c)}', s.${c}::float8`).join(", ")})), '[]'::json)
      from bench_stats.pg_stat_statements s join pg_roles r on r.oid = s.userid
        cross join lateral (select regexp_replace(s.query, '\\s+', ' ', 'g') as q) c
      where s.dbid = (select oid from pg_database where datname = current_database())
        and r.rolname in ('contextvault_worker', 'contextvault_app'))
  )::text`,
};
const ALLOWED = new Set(Object.values(SQL));

export class ServerStatsError extends Error {}
const refuse = (what) => {
  throw new ServerStatsError(`server statistics refused: ${what}`);
};

/** Exact identity of this invocation's container, checked against what was accepted at start. */
function assertSame(docker, spec, accepted) {
  if (spec.profile?.kind !== INGESTION.kind) refuse("not an ingestion benchmark container");
  const inspect = inspectContainer(docker, spec);
  assertContainerSafe(inspect, spec);
  if (!/^[0-9a-f]{64}$/.test(accepted?.Id ?? "") || inspect.Id !== accepted.Id)
    refuse("container id");
  if (inspect.Image !== accepted.Image) refuse("image id");
  if (inspect.State?.Running !== true) refuse("container not running");
  return inspect.Id;
}

/** A channel for the fixed statements above, as the bootstrap superuser, on the container socket. */
function openChannel({ docker, spec, accepted, marker }) {
  const run = (sql) => {
    if (!ALLOWED.has(sql)) refuse("statement not on the allowed list");
    const id = assertSame(docker, spec, accepted);
    const args = ["exec", "-i", id, "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"];
    const done = docker([...args, "-U", "postgres", "-d", spec.database], { input: sql });
    if (done.status !== 0) {
      throw new ServerStatsError(`psql failed: ${done.stderr.trim().slice(0, 200)}`);
    }
    return done.stdout.trim();
  };
  const json = (sql) => {
    const text = run(sql);
    try {
      return JSON.parse(text);
    } catch {
      throw new ServerStatsError("unreadable psql output");
    }
  };
  const seen = json(SQL.marker);
  if (seen.database !== spec.database || seen.marker !== marker) refuse("database identity marker");
  return { run, json, logs: () => logText(docker, assertSame(docker, spec, accepted)) };
}

const logText = (docker, id) => {
  const done = docker(["logs", id]);
  if (done.status !== 0) throw new ServerStatsError("docker logs failed");
  // PostgreSQL logs to stderr only, so that stream grows by appending and a length taken at the
  // reset is a stable offset. stdout (entrypoint messages) is left out so it cannot shift it.
  return done.stderr;
};

function verifyRole(role, name) {
  if (role === undefined) refuse(`role ${name} missing`);
  if (role.schemaUsage || role.canReset) refuse(`${name} can reach the statistics`);
  if (/app|worker/.test(name) && (role.super || role.bypassRls)) refuse(`${name} bypasses RLS`);
}

/** Fails closed unless the extension is loaded, isolated, and no application role can reach it. */
export function verifyFacts(facts) {
  if (facts.superuser !== true) refuse("not the bootstrap superuser");
  for (const [name, value] of Object.entries(SERVER_SETTINGS)) {
    if (facts.settings?.[name] !== value) refuse(`setting ${name} is not ${value}`);
  }
  if (facts.extensionSchema !== "bench_stats") refuse("extension outside bench_stats");
  for (const name of ROLES)
    verifyRole(
      facts.roles?.find((r) => r.role === name),
      name,
    );
}

/**
 * Installs and verifies the extension, then returns the scenario hooks. `accepted` is the inspect
 * record of the container this invocation started and verified; nothing else is ever targeted.
 */
export async function startServerStats({ docker, spec, accepted, marker }) {
  const channel = openChannel({ docker, spec, accepted, marker });
  channel.run(SQL.install);
  const facts = channel.json(SQL.verify);
  verifyFacts(facts);
  let mark = 0;
  return {
    metadata: {
      enabled: true,
      containerIdentityVerified: true,
      extensionSchema: facts.extensionSchema,
      settings: facts.settings,
      roleChecks: facts.roles,
    },
    /** At the start of a scenario's timed window; also marks the log position. */
    reset() {
      mark = channel.logs().length;
      channel.run(SQL.reset);
    },
    /** After the scenario's worker has finished: this scenario's server figures. */
    read({ transactions, errors }) {
      const { info, rows } = channel.json(SQL.read);
      const waits = parseLockWaits(channel.logs().slice(mark));
      return {
        ...summarize({ rows, info, client: clientCounts(transactions), clientErrors: errors }),
        lockWaits: waits,
      };
    },
  };
}
