import { HashingBusy } from "@contextvault/domain";

// Caps concurrent work (each Argon2 hash holds 64 MiB) and refuses, rather than queues, beyond
// `maxQueue` waiters.
export class Semaphore {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueue: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      if (this.waiting.length >= this.maxQueue) throw new HashingBusy();
      // The slot is handed over without decrementing, so no newcomer can overtake a waiter.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.running--;
      else next();
    }
  }
}
