import { assertArgon2Runtime, createPasswordHasher } from "@contextvault/auth";
import { runCli } from "./provisioning/cli";
import { openOps } from "./provisioning/open-ops";
import { createTtyPrompt } from "./provisioning/password-prompt";

// Operator command (`pnpm run user:create`), never imported by an app. Prompts go to stderr so
// stdout carries only the result line.
// pnpm forwards the `--` of `pnpm run user:create -- --email ...` to the script.
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();
const write = (text: string) => process.stderr.write(text);

void runCli(
  argv,
  {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    readSecret: createTtyPrompt(process.stdin, write),
  },
  async (command) => {
    await assertArgon2Runtime();
    return openOps(command, createPasswordHasher());
  },
).then((code) => {
  process.exitCode = code;
});
