import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { hashEmbedder } from "@contextvault/ai";
import { loadS3Env } from "@contextvault/config";
import type { createIngestionHarness } from "@contextvault/db/testing/ingestion";
import {
  type DocumentStore,
  type DocumentVersionId,
  documentObjectKey,
  parseDocumentId,
  parseDocumentVersionId,
  parseWorkspaceId,
  processVersion,
  readVersionBytes,
  type StageInput,
  type StorageKey,
  type WorkspaceId,
} from "@contextvault/domain";
import { type ParsedDocument, parseInChild, parseLimits } from "@contextvault/ingestion";
import { createS3DocumentStore } from "@contextvault/storage";
import { testS3Env } from "@contextvault/storage/testing";
import { createIngestionStages } from "../ingestion-stages";
import { createParsedHandoff } from "../parsed-handoff";

type Harness = Awaited<ReturnType<typeof createIngestionHarness>>;

const workerDir = fileURLToPath(new URL("../../../", import.meta.url));

/** Builds the real worker bundle (parser child included) into a directory of its own. */
export function buildParserChild(): string {
  const out = mkdtempSync(join(tmpdir(), "cv-worker-build-"));
  // Run through this process's own node: the stack wrapper leaves no PATH for a shebang to use.
  execFileSync(
    process.execPath,
    [join(workerDir, "node_modules/tsdown/dist/run.mjs"), "--out-dir", out],
    {
      cwd: workerDir,
      stdio: "pipe",
    },
  );
  return join(out, "parse-child.mjs");
}

// Same isolation guard as the storage tests: fails closed unless the endpoint is the test stack's.
// biome-ignore lint/style/noProcessEnv: launch flags set by the wrapper or the CI runner, not config
const s3Env = testS3Env(loadS3Env(), process.env);
export const store = createS3DocumentStore(s3Env, { maxBytes: parseLimits.maxInputBytes + 1024 });

/** A seeded version of `workspaceId` plus its object, stored where the worker will look. */
export async function seedWithObject(
  h: Harness,
  workspaceId: WorkspaceId,
  body: Uint8Array | null,
): Promise<{ versionId: DocumentVersionId; key: StorageKey }> {
  const versionId = await h.seed(workspaceId);
  const { rows } = await h.fx.fixture.query<{ document_id: string }>(
    "select document_id from document_versions where id = $1",
    [versionId],
  );
  const documentId = parseDocumentId(rows[0]?.document_id ?? "");
  const key = documentObjectKey(
    parseWorkspaceId(workspaceId),
    documentId,
    parseDocumentVersionId(versionId),
  );
  if (body) await store.put(key, Readable.from([body]), body.length);
  return { versionId, key };
}

export function pipeline(
  h: Harness,
  childPath: string,
  wrap: (s: DocumentStore) => DocumentStore = (s) => s,
  parse: (bytes: Uint8Array, signal: StageInput["signal"]) => Promise<ParsedDocument> = (
    bytes,
    signal,
  ) => parseInChild(bytes, signal, { childPath }),
) {
  const handoff = createParsedHandoff();
  const readStore = wrap(store);
  const stages = createIngestionStages({
    readBytes: (input) =>
      readVersionBytes(
        { uow: h.worker.parseSourceUnitOfWork, store: readStore },
        { ...input, maxBytes: parseLimits.maxInputBytes },
      ),
    parse,
    handoff,
    embedder: hashEmbedder,
    newId: randomUUID,
  });
  return {
    handoff,
    process: (
      workspaceId: WorkspaceId,
      versionId: DocumentVersionId,
      signal = new AbortController().signal,
    ) =>
      processVersion(
        { uow: h.worker.unitOfWork, stages, newId: randomUUID },
        { workspaceId, versionId, signal },
      ),
  };
}
