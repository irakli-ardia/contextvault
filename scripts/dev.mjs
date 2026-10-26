#!/usr/bin/env node
// Dev loop for api and worker, run from the app directory: tsdown rebuilds on change and restarts
// the built entry. tsdown never stops its restart child when it dies, so the whole loop runs in
// its own process group and the group is killed on any exit or signal.

import { spawn } from "node:child_process";

// pnpm exec would put tsdown in a group of its own, out of reach of the group kill below.
const loop = spawn(
  "./node_modules/.bin/tsdown",
  ["--watch", "--on-success", "node --env-file-if-exists=../../.env dist/main.mjs"],
  { stdio: "inherit", detached: true },
);

const killGroup = (signal) => {
  if (loop.pid === undefined) return;
  try {
    process.kill(-loop.pid, signal);
  } catch {
    // group already gone
  }
};

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => killGroup(signal));
loop.on("exit", (code) => {
  killGroup("SIGTERM");
  process.exit(code ?? 1);
});
