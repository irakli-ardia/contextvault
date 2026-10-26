import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { InputAborted, NotInteractive } from "./errors";
import { createTtyPrompt, type SecretInput } from "./password-prompt";

class FakeTty extends EventEmitter implements SecretInput {
  isTTY = true;
  raw: boolean[] = [];
  setRawMode = (mode: boolean) => this.raw.push(mode);
  setEncoding = () => this;
  resume = () => this;
  pause = () => this;
  override on(event: "data", listener: (chunk: string) => void): this {
    return super.on(event, listener);
  }
  override off(event: "data", listener: (chunk: string) => void): this {
    return super.off(event, listener);
  }
}

function setup(tty = new FakeTty()) {
  const written: string[] = [];
  return { tty, written, prompt: createTtyPrompt(tty, (t) => written.push(t)) };
}

describe("createTtyPrompt", () => {
  it("collects the line in raw mode and never writes it back", async () => {
    const { tty, written, prompt } = setup();
    const result = prompt("Password: ");
    tty.emit("data", "se");
    tty.emit("data", "cret\u007fX\r");
    expect(await result).toBe("secreX");
    expect(written.join("")).toBe("Password: \n");
    expect(tty.raw).toEqual([true, false]);
    expect(tty.listenerCount("data")).toBe(0);
  });

  it("keeps multi-byte characters whole and ignores arrow keys", async () => {
    const { tty, prompt } = setup();
    const result = prompt("");
    tty.emit("data", "p🔑");
    tty.emit("data", "\u001b[A");
    tty.emit("data", "\u007fä\n");
    expect(await result).toBe("pä");
  });

  it("aborts on Ctrl-C and discards what was typed", async () => {
    const { tty, written, prompt } = setup();
    const result = prompt("Password: ");
    tty.emit("data", "partial\u0003");
    await expect(result).rejects.toBeInstanceOf(InputAborted);
    expect(written.join("")).not.toContain("partial");
    expect(tty.raw).toEqual([true, false]);
  });

  it("refuses without a TTY instead of reading the stream", async () => {
    const tty = new FakeTty();
    tty.isTTY = false;
    const { prompt } = setup(tty);
    await expect(prompt("Password: ")).rejects.toBeInstanceOf(NotInteractive);
    expect(tty.raw).toEqual([]);
    expect(tty.listenerCount("data")).toBe(0);
  });

  it("refuses when raw mode is unavailable", async () => {
    const tty = new FakeTty();
    const bare: SecretInput = {
      isTTY: true,
      setEncoding: tty.setEncoding,
      resume: tty.resume,
      pause: tty.pause,
      on: () => tty,
      off: () => tty,
    };
    await expect(createTtyPrompt(bare, () => undefined)("")).rejects.toBeInstanceOf(NotInteractive);
  });
});
