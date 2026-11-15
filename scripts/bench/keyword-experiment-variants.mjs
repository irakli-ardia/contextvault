// The four alternatives under test. The query is never copied: the production statement is
// rendered by the repository itself, and a stored-column variant only swaps the tsvector
// expression for the column, so ranking and matching semantics cannot drift from production.

const EXPRESSION = "to_tsvector('simple', c.content)";
export const ADD_COLUMN =
  "alter table chunks add column content_tsv tsvector generated always as (to_tsvector('simple', content)) stored";

// Only the throwaway experiment database gets this grant: the application role may read named
// columns of chunks, so a new column is invisible to it until granted (as a real change would need).
export const GRANT_COLUMN = "grant select (content_tsv) on chunks to contextvault_app";

export const RESET = [
  "drop index if exists kw_exp_gin_expression, kw_exp_gin_stored",
  "alter table chunks drop column if exists content_tsv",
  "vacuum full chunks",
];

/** The production statement with its two tsvector expressions replaced by the stored column. */
export function useStoredColumn(sql) {
  const parts = sql.split(EXPRESSION);
  if (parts.length !== 3) {
    throw new Error(`expected 2 occurrences of the tsvector expression, found ${parts.length - 1}`);
  }
  return parts.join("c.content_tsv");
}

export const VARIANTS = [
  { key: "baseline", label: "Current implementation", build: [], indexes: [], rewrite: (s) => s },
  {
    key: "gin_expression",
    label: "GIN expression index",
    build: [
      "create index kw_exp_gin_expression on chunks using gin (to_tsvector('simple', content))",
    ],
    indexes: ["kw_exp_gin_expression"],
    rewrite: (s) => s,
  },
  {
    key: "stored",
    label: "Stored generated tsvector",
    build: [ADD_COLUMN, GRANT_COLUMN],
    indexes: [],
    column: "content_tsv",
    rewrite: useStoredColumn,
  },
  {
    key: "stored_gin",
    label: "Stored generated tsvector with GIN",
    build: [
      ADD_COLUMN,
      GRANT_COLUMN,
      "create index kw_exp_gin_stored on chunks using gin (content_tsv)",
    ],
    indexes: ["kw_exp_gin_stored"],
    column: "content_tsv",
    rewrite: useStoredColumn,
  },
];
