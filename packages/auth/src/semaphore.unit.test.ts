import { HashingBusy } from "@contextvault/domain";
import { describe, expect, it } from "vitest";
import { Semaphore } from "./semaphore";

function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe("Semaphore", () => {
  it("runs at most `limit` tasks at once, queues up to maxQueue, then refuses", async () => {
    const semaphore = new Semaphore(2, 1);
    const { open, opened } = gate();
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await opened;
      running--;
      return "done";
    };
    const first = semaphore.run(task);
    const second = semaphore.run(task);
    const queued = semaphore.run(task);
    await expect(semaphore.run(task)).rejects.toBeInstanceOf(HashingBusy);
    open();
    expect(await Promise.all([first, second, queued])).toEqual(["done", "done", "done"]);
    expect(peak).toBe(2);
  });

  it("releases the slot when a task throws", async () => {
    const semaphore = new Semaphore(1, 0);
    await expect(semaphore.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(semaphore.run(() => Promise.resolve(1))).resolves.toBe(1);
  });
});
