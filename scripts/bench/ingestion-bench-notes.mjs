// What each reported number is, and what the run cannot say. Text only: it travels with every
// result so a reader cannot mistake a client-side timing for a server-side one.

export const MEASUREMENTS = {
  endToEndMs:
    "Enqueue to the end of the activation call, in the benchmark process. Includes queue wait.",
  processingMs:
    "Worker-side: first claim call to the end of the activation call. Excludes queue wait.",
  activationTxMs:
    "Client-observed: begin to commit round trip of the activation transaction (includes event-loop delay in the worker process).",
  clientSqlMs:
    "Every '*ClientMs' field is client-observed: statement sent to result received by the pg driver. It includes network, driver and event-loop scheduling delay, so it is NOT PostgreSQL execution time.",
  serverExecution:
    "Not measured: pg_stat_statements is not enabled in the disposable container. No field reports database-server execution time.",
  eventLoop:
    "Event-loop delay (10 ms sampling) and utilization of the worker process per scenario. Delay inflates every client-observed timing.",
  cpu: "workerCpuCores is process CPU time over wall time (1.0 = one saturated core; the worker's event loop is single-threaded). postgresCpuCores is container CPU time over wall time against a 2-core limit.",
  saturation:
    "A scenario is flagged when the worker event loop utilization or worker CPU is at least 0.9 of one core, or PostgreSQL uses at least 0.9 of its CPU limit: its client timings then include queuing, not only work.",
};

/** Replaces the 'not measured' statements when the optional server statistics are on. */
export const SERVER_STATS_MEASUREMENTS = {
  serverExecution:
    "serverStatements: PostgreSQL executor time per statement class (pg_stat_statements, worker role only), summed over one scenario. It is not per transaction or per activation: only means and the slowest single statement of a class are available, and only classes whose client and server call counts agree are marked valid. Excludes planning (track_planning is off), parse, bind, driver, network and event-loop time. Client-observed '*ClientMs' values are never adjusted by it, and the difference between the two is not a measurement of network latency.",
  lockWaits:
    "lockWaits: waits of at least 100 ms (deadlock_timeout) logged by the server during the scenario, as counts and durations, for every role in this container. The flag sets deadlock_timeout to 100 ms (default 1 s), which changes lock and deadlock checking and can add overhead. Shorter waits are invisible here and are inside execution time.",
};

export const measurementsFor = (serverStats) =>
  serverStats ? { ...MEASUREMENTS, ...SERVER_STATS_MEASUREMENTS } : MEASUREMENTS;

export const LIMITATIONS = [
  "Object reads come from an in-memory store: S3 latency is not measured.",
  "Embeddings are the offline hash embedder; its CPU cost (single thread, in the worker process) is real but a provider's network latency is not.",
  "Jobs are enqueued directly through the production queue producer; the outbox dispatcher and recovery sweeps are not exercised.",
  "Plain-text documents only; PDF parsing is not measured.",
  "Everything runs on one machine: PostgreSQL is limited to 2 CPUs, but the worker process, Redis and Docker share the host, so absolute numbers are hardware-bound and CPU contention between them is possible.",
  "Scenarios share one database, so tables grow between them. The concurrency comparison rotates the order of levels over whole rounds (each level in each position equally often) to cancel a linear growth effect; non-linear effects (autovacuum, checkpoints, cache warmth) remain, and the per-scenario starting row counts are reported so they can be inspected.",
  "Concurrency 1, 2 and 4 are compared with identical documents, but only on this host: the worker's single event loop makes CPU-bound stages (parse, chunk, hash embedding) contend for one thread, so higher concurrency mainly overlaps database and child-process waits.",
  "Client-observed SQL timings include event-loop delay; no database-server execution time is measured.",
  "No fault was injected: failures, retries and timeouts reported are only those that happened.",
  "The run is of the current schema only: there is no content_tsv column to compare against.",
];

const NO_SERVER_TIME =
  "Client-observed SQL timings include event-loop delay; no database-server execution time is measured.";
const SERVER_STATS_LIMITS = [
  "Server statement statistics are aggregated per statement class and scenario, not per transaction or activation. Planning time is not collected, begin/commit/rollback are reported but not validated, and statements outside a client transaction are not seen by the client probe, so a class whose counts differ is marked invalid rather than adjusted.",
  "--server-stats changes deadlock_timeout from its 1 s default to 100 ms, which makes the server check for deadlocks sooner and log lock waits of 100 ms or more; that alters lock and deadlock checking behavior and can add measurement overhead. It is not subtracted, and runs with and without the flag are not interchangeable.",
  "Statement statistics add overhead of their own (the extension and lock-wait logging run in the measured container); it is not subtracted and has not been calibrated by this run.",
  "Statement identifiers are never compared across databases, runs or schema variants.",
];

const BASELINE_SCHEMA_ONLY = LIMITATIONS.at(-1);
const STORED_TSV_ONLY =
  "The run is of the stored-tsv arm only: the ADR 0012 content_tsv column (STORED, no index) was added by the harness after the migrations. It is not compared with the baseline arm here; any comparison is made across separate runs and is not measured by this run.";

export function limitationsFor(serverStats, schema = "baseline") {
  const base = LIMITATIONS.map((l) =>
    l === BASELINE_SCHEMA_ONLY && schema === "stored-tsv" ? STORED_TSV_ONLY : l,
  );
  return serverStats ? [...base.filter((l) => l !== NO_SERVER_TIME), ...SERVER_STATS_LIMITS] : base;
}
