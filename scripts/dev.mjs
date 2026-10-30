#!/usr/bin/env node
// Dev loop for api and worker, run from the app directory: tsdown rebuilds on change and restarts
// the built entry. tsdown never stops its restart child when it dies, so the whole loop runs in
// its own process group and the group is killed on any exit or signal. The entry runs through
// run-with-env.mjs, which gives it only the app's allowlisted variables from the repo-root `.env`.
// Usage: dev.mjs <api|worker>

import { spawn } from "node:child_process";

const app = process.argv[2];
if (app !== "api" && app !== "worker") {
  console.error("usage: dev.mjs <api|worker>");
  process.exit(2);
}

// pnpm exec would put tsdown in a group of its own, out of reach of the group kill below.
const loop = spawn(
  "./node_modules/.bin/tsdown",
  ["--watch", "--on-success", `node ../../scripts/run-with-env.mjs ${app} dist/main.mjs`],
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

// A signal already went to the whole group; signalling it again on exit would hand the entry a
// second SIGTERM mid-shutdown and kill it before it finished closing.
let signalled = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    signalled = true;
    killGroup(signal);
  });
}
loop.on("exit", (code) => {
  if (!signalled) killGroup("SIGTERM");
  process.exit(code ?? 1);
});
