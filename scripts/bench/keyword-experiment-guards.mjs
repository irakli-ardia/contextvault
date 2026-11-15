// Guards around the experiment's process: Docker must be a local daemon, and a signal must still
// remove the container and keep what was measured.

import { dockerEnvironment } from "./keyword-experiment-container.mjs";

// An absolute Unix socket (Docker Desktop, Linux). TCP, SSH, TLS and named pipes are refused.
const LOCAL = /^unix:\/\/\/[^\s]+$/;
const refuse = (what) => {
  throw new Error(`docker refused: ${what}`);
};

/**
 * Resolves the endpoint the docker CLI is about to use (DOCKER_HOST wins, otherwise the active
 * context, which honours DOCKER_CONTEXT and DOCKER_CONFIG) and requires it to be a local socket.
 */
export function assertLocalDocker({ docker, env = dockerEnvironment() }) {
  if (env.DOCKER_HOST) {
    if (!LOCAL.test(env.DOCKER_HOST)) refuse("DOCKER_HOST is not a local unix socket");
    return;
  }
  const name = docker(["context", "show"]);
  if (name.status !== 0 || !/^[\w.-]+$/.test(name.stdout.trim())) refuse("no active context");
  const host = docker([
    "context",
    "inspect",
    name.stdout.trim(),
    "--format",
    "{{.Endpoints.docker.Host}}",
  ]);
  if (host.status !== 0 || !LOCAL.test(host.stdout.trim())) {
    refuse("the active context is not a local unix socket");
  }
}

const EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/**
 * Runs `onSignal` once on the first SIGINT, SIGTERM or SIGHUP, then exits. Later signals during
 * cleanup are ignored. Returns the function that removes the handlers.
 */
export function installSignalCleanup(onSignal, proc = process) {
  let fired = false;
  const handlers = Object.keys(EXIT).map((signal) => {
    const handler = () => {
      if (fired) return;
      fired = true;
      try {
        onSignal(signal);
      } finally {
        proc.exit(EXIT[signal]);
      }
    };
    proc.on(signal, handler);
    return [signal, handler];
  });
  return () => {
    for (const [signal, handler] of handlers) proc.off(signal, handler);
  };
}
