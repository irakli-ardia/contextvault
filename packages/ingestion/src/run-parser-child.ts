import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { DeadlineSignal } from "@contextvault/domain";
import { z } from "zod";
import { parseLimits } from "./limits";
import { ParseFailure, parseErrorCodes } from "./parse-failure";
import { type ParsedDocument, parsedDocumentSchema } from "./parsed-document";

export interface ParserChildOptions {
  /** The built child entry: reads the document on stdin, writes one JSON line on stdout. */
  readonly childPath: string;
  readonly timeoutMs?: number;
  readonly heapMb?: number;
  readonly maxOutputBytes?: number;
}

const childMessage = z.union([
  z.object({ ok: z.literal(true), document: parsedDocumentSchema }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(parseErrorCodes) }).strict(),
]);

// A worker that dies mid-parse (a process guard, an unfinished shutdown) must not leave parsers
// running: its children are killed on the way out. 'exit' handlers run synchronously.
const live = new Set<ChildProcess>();
process.once("exit", () => {
  for (const child of live) child.kill("SIGKILL");
});

/** The caller cancelled or lost the lease: not a verdict on the document. */
export class ParseCancelled extends Error {
  constructor() {
    super("parse.cancelled");
  }
}

// ADR 0011. The child gets no environment, no file access beyond the directory of its own build
// (the permission model also denies writes, child processes, workers and addons) and a heap cap. It is killed on
// timeout, cancellation or an oversized answer, and the call settles only when the process has
// closed, so no parser outlives its job. Anything unexpected about the exit or the answer is
// `parse.corrupt`: stderr is drained and discarded because it may quote the document.
export function parseInChild(
  bytes: Uint8Array,
  signal: DeadlineSignal,
  options: ParserChildOptions,
): Promise<ParsedDocument> {
  const timeoutMs = options.timeoutMs ?? parseLimits.timeoutMs;
  const maxOutput = options.maxOutputBytes ?? parseLimits.maxOutputBytes;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ParseCancelled());
    // The permission model compares real paths, so a symlinked directory would deny the script itself.
    // The build output may split into chunks the entry imports, hence the directory, not the file.
    const childPath = realpathSync(options.childPath);
    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${dirname(childPath)}`,
        `--max-old-space-size=${options.heapMb ?? parseLimits.heapMb}`,
        childPath,
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: {}, windowsHide: true },
    );
    live.add(child);
    let verdict: "timeout" | "cancelled" | "oversized" | undefined;
    const kill = (reason: typeof verdict) => {
      verdict ??= reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    const onAbort = () => kill("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });

    const out: Buffer[] = [];
    let outBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxOutput) kill("oversized");
      else out.push(chunk);
    });
    child.stderr.resume();
    // A child that dies before reading its input closes the pipe; the exit status says why.
    child.stdin.on("error", () => undefined);
    child.stdin.end(bytes);

    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.delete(child);
      signal.removeEventListener("abort", onAbort);
      finish();
    };
    // Could not start at all: not a verdict on the document, so the stage may retry it.
    child.on("error", (error) =>
      settle(() => reject(new Error("parse.spawn_failed", { cause: error }))),
    );
    child.on("close", (code, killedBy) =>
      settle(() => {
        if (verdict === "cancelled") return reject(new ParseCancelled());
        if (verdict === "timeout") return reject(new ParseFailure("parse.timeout"));
        if (verdict === "oversized" || code !== 0 || killedBy !== null) {
          return reject(new ParseFailure("parse.corrupt"));
        }
        try {
          const message = childMessage.parse(JSON.parse(Buffer.concat(out).toString("utf8")));
          if (message.ok) return resolve(message.document);
          reject(new ParseFailure(message.code));
        } catch {
          reject(new ParseFailure("parse.corrupt"));
        }
      }),
    );
  });
}
