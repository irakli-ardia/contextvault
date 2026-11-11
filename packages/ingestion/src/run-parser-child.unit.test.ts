import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ParseCancelled, parseInChild } from "./run-parser-child";

// Stand-in children: the host's guarantees (kill, caps, validation, sandbox) do not depend on the
// parser, so each fixture misbehaves in one way. The real child is exercised in the worker.
const dir = mkdtempSync(join(tmpdir(), "cv-child-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(dir, { recursive: true });

const answer = (document: unknown) =>
  `process.stdout.write(JSON.stringify(${JSON.stringify(document)}));`;
const fixtures = {
  ok: answer({ ok: true, document: { format: "text", text: "hello" } }),
  encrypted: answer({ ok: false, code: "parse.encrypted" }),
  unknownCode: answer({ ok: false, code: "parse.nope" }),
  extraField: answer({ ok: true, document: { format: "text", text: "x", extra: 1 } }),
  carriageReturn: answer({ ok: true, document: { format: "text", text: "a\rb" } }),
  nul: answer({ ok: true, document: { format: "text", text: "a\u0000b" } }),
  loneSurrogate:
    'process.stdout.write(\'{"ok":true,"document":{"format":"text","text":"a\\\\ud800"}}\');',
  oversizedText: answer({ ok: true, document: { format: "text", text: "x".repeat(2_000_001) } }),
  garbage: "process.stdout.write('not json');",
  crash: "process.exit(3);",
  hang: "setInterval(() => {}, 1000);",
  flood: "const b = Buffer.alloc(65536, 97); setInterval(() => process.stdout.write(b), 1);",
  heap: "const a = []; for (;;) a.push(new Array(1e5).fill('x'.repeat(100)));",
  sandbox: `const fs = require('node:fs'); let denied = false;
    try { fs.readFileSync('/etc/hosts'); } catch { denied = true; }
    try { fs.writeFileSync(${JSON.stringify(join(dir, "w"))}, 'x'); } catch { denied &&= true; }
    let spawnDenied = false;
    try { require('node:child_process').execSync('true'); } catch { spawnDenied = true; }
    process.stdout.write(JSON.stringify({ ok: true, document: { format: 'text',
      text: JSON.stringify({ denied, spawnDenied, env: Object.keys(process.env) }) } }));`,
  echo: `let n = 0; process.stdin.on('data', (c) => { n += c.length; }).on('end', () =>
    process.stdout.write(JSON.stringify({ ok: true, document: { format: 'text', text: String(n) } })));`,
} as const;
const pathOf = (name: keyof typeof fixtures) => join(dir, `${name}.cjs`);
for (const [name, source] of Object.entries(fixtures))
  writeFileSync(join(dir, `${name}.cjs`), source);

const never = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
const run = (
  name: keyof typeof fixtures,
  extra: { timeoutMs?: number; heapMb?: number; maxOutputBytes?: number } = {},
  bytes = new Uint8Array([1]),
) => parseInChild(bytes, never, { childPath: pathOf(name), ...extra });
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : error;
  }
  return "resolved";
};

describe("parseInChild", () => {
  it("returns a validated document and feeds all input bytes", async () => {
    expect(await run("ok")).toEqual({ format: "text", text: "hello" });
    expect(await run("echo", {}, new Uint8Array(300_000))).toMatchObject({ text: "300000" });
  });

  it("maps a reported failure to its code", async () => {
    expect(await code(run("encrypted"))).toBe("parse.encrypted");
  });

  it.each([
    "unknownCode",
    "extraField",
    "carriageReturn",
    "nul",
    "loneSurrogate",
    "oversizedText",
    "garbage",
    "crash",
  ] as const)("treats %s as a corrupt document, never as a result", async (name) => {
    expect(await code(run(name))).toBe("parse.corrupt");
  });

  it("kills a child that never answers", async () => {
    const started = Date.now();
    expect(await code(run("hang", { timeoutMs: 300 }))).toBe("parse.timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("kills a child whose output passes the cap", async () => {
    expect(await code(run("flood", { maxOutputBytes: 100_000 }))).toBe("parse.corrupt");
  });

  it("bounds the heap", async () => {
    expect(await code(run("heap", { heapMb: 32 }))).toBe("parse.corrupt");
  });

  it("runs the child without environment, file access or subprocesses", async () => {
    vi.stubEnv("DATABASE_WORKER_URL", "postgres://secret");
    const result = await run("sandbox");
    const seen = JSON.parse(result.text);
    expect(seen).toMatchObject({ denied: true, spawnDenied: true });
    // The OS may add a variable of its own (macOS adds one); nothing of the parent's gets through.
    expect(seen.env).not.toEqual(expect.arrayContaining(["DATABASE_WORKER_URL", "PATH"]));
    expect(seen.env.length).toBeLessThanOrEqual(1);
  });

  it("cancels on the caller's signal, before and during the run", async () => {
    const controller = new AbortController();
    const pending = code(
      parseInChild(new Uint8Array([1]), controller.signal, { childPath: pathOf("hang") }),
    );
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toBeInstanceOf(ParseCancelled);
    expect(
      await code(parseInChild(new Uint8Array([1]), controller.signal, { childPath: pathOf("ok") })),
    ).toBeInstanceOf(ParseCancelled);
  });
});
