// What a result records about where it came from, and the guard that keeps private values out of
// it. Only repository-relative paths, counts, hashes and public image references are written:
// never credentials, connection strings, absolute paths or environment values.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const MAX_DIRTY = 100;
const SECRET_PATH = /(^|\/)\.env|secret|credential|password|\.pem$|\.key$/i;
const CREDENTIAL_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s"'/]*:[^\s"'@/]*@/i;
const CONNECTION = /\b(postgres(ql)?|redis|rediss|amqp|mongodb):\/\//i;

/** A unique id for this invocation; the container run id is a separate short value. */
export const newExperimentId = () => `ingestion-${randomUUID()}`;

/**
 * Commit, cleanliness and the dirty files of the checkout. Paths are repository-relative and a
 * secret-looking path is replaced by a placeholder; `diffSha256` fingerprints the tracked changes
 * without recording any content.
 */
export function gitProvenance(run = spawnSync) {
  const git = (args) => {
    try {
      const done = run("git", args, {
        encoding: "utf8",
        cwd: root,
        timeout: 10_000,
        maxBuffer: 1 << 28,
      });
      return done.status === 0 ? done.stdout : null;
    } catch {
      return null;
    }
  };
  const sha = git(["rev-parse", "HEAD"])?.trim() ?? null;
  const status = sha === null ? null : git(["status", "--porcelain", "--no-renames", "-z"]);
  if (status === null)
    return {
      gitSha: sha,
      workingTreeDirty: null,
      dirtyFiles: null,
      dirtyFilesTruncated: false,
      diffSha256: null,
    };
  const entries = status
    .split("\0")
    .filter(Boolean)
    .map((e) => ({
      status: e.slice(0, 2).trim(),
      path: SECRET_PATH.test(e.slice(3)) ? "<redacted>" : e.slice(3),
    }));
  const diff = git(["diff", "HEAD"]);
  return {
    gitSha: sha,
    workingTreeDirty: entries.length > 0,
    dirtyFiles: entries.slice(0, MAX_DIRTY),
    dirtyFilesTruncated: entries.length > MAX_DIRTY,
    diffSha256: diff === null ? null : createHash("sha256").update(diff).digest("hex"),
  };
}

/** The command line as given, with the output path reduced to its file name. */
export function explicitArgs(argv) {
  return argv.map((a) => (a.startsWith("--out=") ? `--out=${basename(a.slice(6))}` : a));
}

/** Facts of one container that `docker inspect` states: image id and resource limits. */
export function containerFacts(inspect, image) {
  const host = inspect.HostConfig ?? {};
  return {
    image,
    imageId: inspect.Image ?? null,
    memoryLimitBytes: host.Memory || null,
    cpuLimit: host.NanoCpus ? host.NanoCpus / 1e9 : null,
    pidsLimit: host.PidsLimit ?? null,
  };
}

/** Replaces anything private in free text (an error message) before it is stored. */
export function sanitizeText(text, secrets = [], { repo = root, home = homedir() } = {}) {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join("<redacted>");
  out = out.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, "<url>");
  if (repo) out = out.split(repo).join("<repo>/");
  if (home) out = out.split(home).join("<home>");
  return out;
}

/** The reasons a serialized result must not be written, or an empty list. */
export function leaks(text, secrets = [], { repo = root, home = homedir() } = {}) {
  const found = [];
  if (secrets.some((s) => s && text.includes(s))) found.push("a generated secret");
  if (CREDENTIAL_URL.test(text) || CONNECTION.test(text)) found.push("a connection string");
  if ((repo && text.includes(repo)) || (home && text.includes(home)))
    found.push("an absolute path");
  return found;
}
