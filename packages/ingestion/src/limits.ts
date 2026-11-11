// The product limits of the plan (M1 §1) and the process bounds of ADR 0011. One place, so the
// child, the host and the tests cannot disagree.
export const parseLimits = {
  maxInputBytes: 10 * 1024 * 1024,
  maxPages: 100,
  maxChars: 2_000_000,
  timeoutMs: 60_000,
  heapMb: 192,
  /** Worst case is 2,000,000 chars escaped as \uXXXX plus structure. */
  maxOutputBytes: 16 * 1024 * 1024,
} as const;
