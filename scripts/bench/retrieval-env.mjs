// What the report says about the machine and the server it ran against.

import os from "node:os";

export async function environment(fixture, app, { runs, smoke }) {
  const { rows: settings } =
    await fixture.query(`select name, setting from pg_settings where name in
    ('shared_buffers','work_mem','effective_cache_size','random_page_cost','jit','max_parallel_workers_per_gather','autovacuum','statement_timeout')`);
  const {
    rows: [v],
  } = await fixture.query(
    "select version() as version, (select extversion from pg_extension where extname = 'vector') as pgvector",
  );
  const {
    rows: [c],
  } = await fixture.query(
    "select (select count(*) from chunks)::int as chunks, (select count(*) from workspaces)::int as workspaces",
  );
  return {
    appStatementTimeout: (await app.query("show statement_timeout")).rows[0].statement_timeout,
    postgres: v.version,
    pgvector: v.pgvector,
    settings: Object.fromEntries(settings.map((s) => [s.name, s.setting])),
    rowsBeforeSeed: c,
    node: process.version,
    cpu: `${os.cpus()[0].model} x${os.cpus().length}`,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    platform: `${os.platform()} ${os.release()}`,
    runsPerMeasurement: runs,
    smoke,
  };
}
