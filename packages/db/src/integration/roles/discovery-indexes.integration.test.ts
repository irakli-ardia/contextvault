import { afterAll, describe, expect, it } from "vitest";
import { openRolePools } from "./role-test-support";

// Pins the indexes recovery discovery depends on (migrations 0012, 0013). Without the outbox
// history index every scan re-reads the whole outbox per waiting version; benchmarks/orphan-discovery
// measured 13-23 s per page without it and 2-6 ms with both indexes. Definitions, not plans: a
// planner's choice on a small test table proves nothing.
const pools = openRolePools();
afterAll(() => pools.close());

const definition = async (name: string) =>
  (
    await pools.bootstrap.query<{ def: string }>(
      "select indexdef as def from pg_indexes where schemaname = 'public' and indexname = $1",
      [name],
    )
  ).rows[0]?.def;

describe("recovery discovery indexes", () => {
  it.each([
    [
      "document_versions_running_updated_idx",
      "ON public.document_versions USING btree (updated_at) WHERE (status = ANY (ARRAY['parsing'::text, 'chunking'::text]))",
    ],
    [
      "document_versions_waiting_updated_idx",
      "ON public.document_versions USING btree (updated_at, id) WHERE (status = ANY (ARRAY['uploaded'::text, 'queued'::text]))",
    ],
    ["outbox_workspace_version_idx", "ON public.outbox USING btree (workspace_id, version_id)"],
  ])("%s has the reviewed definition", async (name, tail) => {
    expect(await definition(name)).toBe(`CREATE INDEX ${name} ${tail}`);
  });
});
