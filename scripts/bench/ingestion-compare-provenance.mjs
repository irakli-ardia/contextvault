// What must be identical across the runs of one comparison. Only differences that every run has by
// construction (output file, schema arm, ids, timestamps) are removed; everything that shapes the
// workload, the host, the images or the source tree is kept and compared exactly.

const PER_RUN_ARGUMENT = /^--(out|schema)(=|$)/;

const omit = (object, keys) =>
  Object.fromEntries(Object.entries(object ?? {}).filter(([key]) => !keys.includes(key)));

// Harness results nest under ten levels. The bound keeps an untrusted file from exhausting the
// stack; `loadText` canonicalizes every run it accepts, so a deeper one is rejected there.
const MAX_DEPTH = 32;

const sortKeys = (value, depth = 0) => {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) throw new RangeError("value nested too deeply");
  if (Array.isArray(value)) return value.map((item) => sortKeys(item, depth + 1));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key], depth + 1)]),
  );
};

/** Key-order independent text of a value, for exact comparison. */
export const canonical = (value) => JSON.stringify(sortKeys(value) ?? null);

/** The comparable part of one result. */
export function normalizeProvenance(result) {
  return {
    gitSha: result.gitSha,
    workingTreeDirty: result.workingTreeDirty,
    diffSha256: result.diffSha256,
    containers: result.containers,
    environment: result.environment,
    config: omit(result.config, ["outputFile"]),
    serverStats: result.serverStats ?? null,
    cli: {
      command: result.cli?.command,
      // Order carries no meaning (the harness parses options by name and refuses repeats), so
      // equivalent command lines compare equal; values and every other option stay.
      arguments: (Array.isArray(result.cli?.arguments) ? result.cli.arguments : [])
        .filter((a) => typeof a === "string" && !PER_RUN_ARGUMENT.test(a))
        .sort(),
    },
  };
}

export const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Field names (one level into objects) where `other` differs from `reference`. */
function differences(reference, other) {
  return Object.keys({ ...reference, ...other }).flatMap((field) => {
    if (canonical(reference[field]) === canonical(other[field])) return [];
    if (!isRecord(reference[field]) || !isRecord(other[field])) return [field];
    return Object.keys({ ...reference[field], ...other[field] })
      .filter((key) => canonical(reference[field][key]) !== canonical(other[field][key]))
      .map((key) => `${field}.${key}`);
  });
}

/** `items` are `{ file, provenance }`; the first is the reference and nothing is dropped. */
export function compareProvenance(items) {
  const [reference, ...rest] = items;
  if (reference === undefined) return { consistent: true, reference: null, mismatches: [] };
  const mismatches = rest
    .map(({ file, provenance }) => ({
      file,
      fields: differences(reference.provenance, provenance),
    }))
    .filter((m) => m.fields.length > 0);
  return { consistent: mismatches.length === 0, reference: reference.file, mismatches };
}
