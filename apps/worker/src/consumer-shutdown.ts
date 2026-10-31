/** Counts the deliveries whose handler is still running, and lets shutdown wait for none. */
export function createActiveJobs() {
  let count = 0;
  const waiting = new Set<() => void>();
  return {
    get size(): number {
      return count;
    },
    async run<T>(work: () => Promise<T>): Promise<T> {
      count += 1;
      try {
        return await work();
      } finally {
        count -= 1;
        if (count === 0) {
          for (const resolve of waiting) resolve();
          waiting.clear();
        }
      }
    },
    idle(): Promise<void> {
      return count === 0 ? Promise.resolve() : new Promise((resolve) => waiting.add(resolve));
    },
  };
}

/**
 * True when `promise` settled (either way) within `ms`. Waiting is all this bounds: a promise that
 * loses the race keeps running, because JavaScript cannot terminate it.
 */
export async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Shutdown ended while stage work was still running: the consumer stopped, that work did not. */
export class IngestionShutdownIncomplete extends Error {
  constructor(
    readonly abandonedJobs: number,
    options?: ErrorOptions,
  ) {
    super("ingestion.shutdown_incomplete", options);
    this.name = "IngestionShutdownIncomplete";
  }
}
