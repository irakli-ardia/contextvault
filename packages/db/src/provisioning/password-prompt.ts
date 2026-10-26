import { InputAborted, NotInteractive } from "./errors";

export interface SecretInput {
  readonly isTTY?: boolean;
  readonly setRawMode?: (mode: boolean) => unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
}

const ctrlC = "\u0003";
const ctrlD = "\u0004";
const escapeKey = "\u001b";

// Reads one line from an interactive terminal in raw mode, so nothing is echoed. There is no
// fallback: without a TTY it refuses instead of reading a pipe, a file, or the environment.
export function createTtyPrompt(
  input: SecretInput,
  write: (text: string) => void,
): (prompt: string) => Promise<string> {
  return (prompt) =>
    new Promise((resolve, reject) => {
      const setRawMode = input.setRawMode;
      if (input.isTTY !== true || setRawMode === undefined) return reject(new NotInteractive());
      let value = "";
      const restore = () => setRawMode.call(input, false);
      const onSignal = () => {
        restore();
        process.exit(1);
      };
      const finish = (settle: () => void) => {
        input.off("data", onData);
        process.off("SIGTERM", onSignal);
        process.off("SIGHUP", onSignal);
        restore();
        input.pause();
        write("\n");
        settle();
      };
      const onData = (chunk: string) => {
        if (chunk.startsWith(escapeKey)) return; // arrow and function keys
        for (const char of chunk) {
          if (char === "\r" || char === "\n") return finish(() => resolve(value));
          if (char === ctrlC || char === ctrlD) {
            value = "";
            return finish(() => reject(new InputAborted()));
          }
          if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
          else if (char >= " ") value += char;
        }
      };
      write(prompt);
      setRawMode.call(input, true);
      input.setEncoding("utf8");
      input.resume();
      input.on("data", onData);
      process.once("SIGTERM", onSignal);
      process.once("SIGHUP", onSignal);
    });
}
