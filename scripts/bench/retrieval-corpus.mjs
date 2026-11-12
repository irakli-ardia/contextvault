// Deterministic synthetic corpus for the retrieval benchmark. Everything derives from the chunk
// index through a seeded PRNG and md5-derived ids, so any two runs (and any two sizes: a smaller
// corpus is a prefix of a larger one) hold byte-identical rows. `corpusDigest` proves it.

import { createHash } from "node:crypto";

export const DIMENSIONS = 1536;
export const MODEL = "bench-v1";
export const DOCUMENTS = 50; // uploadQuota.maxDocuments
const VOCABULARY = 20_000;
const WORDS_PER_CHUNK = 380; // ~1900 characters, the fixed-window strategy's 2000-unit window

/** mulberry32: small, fast, and identical on every platform. */
export function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable uuid-shaped id from a label and an index. */
export function idOf(label, index) {
  const hex = createHash("md5").update(`${label}:${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Planted terms with known frequencies, so keyword workloads have predictable selectivity.
export const PLANTED = [
  { term: "kwcommon", every: 2, offset: 0 }, // 50% of chunks
  { term: "kwmid", every: 100, offset: 0 }, // 1%
  { term: "kwrare", every: 5000, offset: 7 }, // 0.02%
];
export const PHRASE = { text: "kwphrase kwalpha", every: 250, offset: 3 };
const planted = (index) => [
  ...PLANTED.filter((p) => index % p.every === p.offset).map((p) => p.term),
  ...(index % PHRASE.every === PHRASE.offset ? [PHRASE.text] : []),
];

/** Expected number of chunks containing a planted term among the first `n`. */
export const plantedCount = (n, { every, offset }) =>
  n <= offset ? 0 : Math.floor((n - 1 - offset) / every) + 1;

/** Zipf-like words (cubed uniform draw): a few very common words, a long rare tail. */
export function chunkText(index) {
  const rand = rng(1_000_003 + index);
  const words = [];
  for (let i = 0; i < WORDS_PER_CHUNK; i += 1) {
    words.push(`t${Math.floor(VOCABULARY * rand() ** 3).toString(36)}`);
  }
  // Planted terms go in the middle so they are not edge cases for the tokenizer.
  words.splice(Math.floor(WORDS_PER_CHUNK / 2), 0, ...planted(index));
  return words.join(" ");
}

/** A random unit vector as a pgvector literal; 5 decimals keep the statement small. */
export function vectorLiteral(seed) {
  const rand = rng(seed);
  const values = [];
  let norm = 0;
  for (let i = 0; i < DIMENSIONS; i += 2) {
    const radius = Math.sqrt(-2 * Math.log(1 - rand()));
    const angle = 2 * Math.PI * rand();
    values.push(radius * Math.cos(angle), radius * Math.sin(angle));
  }
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm);
  return `[${values.map((value) => (value / norm).toFixed(5)).join(",")}]`;
}

export const chunkVector = (index) => vectorLiteral(2_000_003 + index);
export const queryVector = (n) => vectorLiteral(3_000_017 + n);

/** The planned rows of chunk `index` in a corpus of `total` chunks over DOCUMENTS documents. */
export function chunkRow(index, total, ids) {
  const perDocument = Math.ceil(total / DOCUMENTS);
  const document = Math.floor(index / perDocument);
  const content = chunkText(index);
  return {
    id: ids.chunk(index),
    versionId: ids.version(document),
    sectionId: ids.section(document),
    ordinal: index - document * perDocument,
    content,
    startOffset: (index - document * perDocument) * 1800,
    endOffset: (index - document * perDocument) * 1800 + content.length,
  };
}

/** sha256 over every chunk text and the query vectors: equal digests mean equal datasets. */
export function corpusDigest(total, queries = 3) {
  const hash = createHash("sha256");
  for (let i = 0; i < total; i += 1) hash.update(chunkText(i)).update(chunkVector(i));
  for (let q = 0; q < queries; q += 1) hash.update(queryVector(q));
  return hash.digest("hex");
}

/** Keyword workloads over the planted terms; `expects` is the exact number of matching chunks. */
export const keywordCases = (n) => [
  { key: "rare", query: "kwrare", expects: plantedCount(n, PLANTED[2]) },
  { key: "mid", query: "kwmid", expects: plantedCount(n, PLANTED[1]) },
  { key: "common", query: "kwcommon", expects: plantedCount(n, PLANTED[0]) },
  // kwcommon (even index) and kwmid (multiple of 100): every multiple of 100.
  { key: "and", query: "kwcommon kwmid", expects: plantedCount(n, PLANTED[1]) },
  { key: "phrase", query: '"kwphrase kwalpha"', expects: plantedCount(n, PHRASE) },
  { key: "absent", query: "kwabsent", expects: 0 },
];
