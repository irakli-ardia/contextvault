import { createIngestionHarness } from "@contextvault/db/testing/ingestion";
import { readVersionBytes, StorageError } from "@contextvault/domain";
import { parseLimits } from "@contextvault/ingestion";
import { buildEncryptedPdf, buildPdf } from "@contextvault/ingestion/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildParserChild, pipeline, seedWithObject, store } from "./parse-pipeline-test-support";

// Claim, real read from SeaweedFS, the real isolated parser child, fenced transitions in PostgreSQL.
const h = await createIngestionHarness();
const { wsA, wsB } = h;
let childPath = "";
beforeAll(() => {
  childPath = buildParserChild();
}, 60_000);
afterAll(() => h.close());

const utf8 = (text: string) => new TextEncoder().encode(text);
const run = async (body: Uint8Array | null, ws = wsA) => {
  const seeded = await seedWithObject(h, ws, body);
  const result = await pipeline(h, childPath).process(ws, seeded.versionId);
  return { ...seeded, result, row: await h.row(seeded.versionId) };
};

const storedChunks = async (versionId: string) =>
  (
    await h.fx.fixture.query<{
      content: string;
      start_offset: number;
      end_offset: number;
      page: number | null;
    }>(
      `select c.content, c.start_offset, c.end_offset, s.page from chunks c
       join sections s on s.id = c.section_id where c.version_id = $1 order by c.ordinal`,
      [versionId],
    )
  ).rows;
const activeVersion = async (versionId: string) =>
  (
    await h.fx.fixture.query<{ a: string | null }>(
      `select d.active_version_id as a from documents d
       join document_versions v on v.document_id = d.id where v.id = $1`,
      [versionId],
    )
  ).rows[0]?.a;

describe("parsing through the worker", () => {
  it("parses text and PDF to the ready state, with chunks", async () => {
    const text = await run(utf8("გამარჯობა\r\nworld"));
    expect(text.result).toEqual({ outcome: "processed" });
    expect(text.row).toMatchObject({ status: "ready", attempt: 1, error_code: null });
    const pdf = await run(buildPdf(["Hello world", "Second page"]));
    expect(pdf.row.status).toBe("ready");

    const chunks = await storedChunks(text.versionId);
    expect(chunks).toEqual([
      { content: "გამარჯობა\nworld", start_offset: 0, end_offset: 15, page: null },
    ]);
    expect((await storedChunks(pdf.versionId)).map((c) => [c.content, c.page])).toEqual([
      ["Hello world", 1],
      ["Second page", 2],
    ]);
    expect(await activeVersion(text.versionId)).toBe(text.versionId);
  });

  it("chunks a long text deterministically, with offsets that round-trip", async () => {
    const body = "ქართული ტექსტი 😀 ".repeat(600);
    const { versionId, row } = await run(utf8(body));
    expect(row.status).toBe("ready");
    const chunks = await storedChunks(versionId);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(body.slice(c.start_offset, c.end_offset)).toBe(c.content);
    expect(chunks.at(-1)?.end_offset).toBe(body.length);
  });

  it("persists every chunk of the largest supported document, without truncation", async () => {
    const unit = "lorem ipsum dolor sit amet ";
    const body = unit
      .repeat(Math.ceil(parseLimits.maxChars / unit.length))
      .slice(0, parseLimits.maxChars);
    const { versionId, row } = await run(utf8(body));
    expect(row.status).toBe("ready");
    const chunks = await storedChunks(versionId);
    expect(chunks.length).toBeGreaterThan(1_000);
    expect(chunks.at(-1)?.end_offset).toBe(body.length);
    chunks.forEach((c, i) => {
      expect(c.start_offset).toBeLessThan(c.end_offset);
      if (i > 0) expect(c.start_offset).toBeLessThanOrEqual(chunks[i - 1]?.end_offset ?? 0);
    });
    const { rows } = await h.fx.fixture.query<{ n: string; ords: string }>(
      "select count(*) as n, count(distinct ordinal) as ords from chunks where version_id = $1",
      [versionId],
    );
    expect(rows[0]).toEqual({ n: String(chunks.length), ords: String(chunks.length) });
  }, 60_000);

  it("fails a document the parser accepted but that holds no visible text, with chunk.no_content", async () => {
    const seeded = await seedWithObject(h, wsA, utf8("x"));
    const blank = async () => ({ format: "text" as const, text: " \n\t " });
    const result = await pipeline(h, childPath, (s) => s, blank).process(wsA, seeded.versionId);
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { stage: "chunking", code: "chunk.no_content", retryable: false },
    });
    expect(await h.row(seeded.versionId)).toMatchObject({
      status: "failed",
      error_stage: "chunking",
      error_code: "chunk.no_content",
    });
    expect(await storedChunks(seeded.versionId)).toEqual([]);
    expect(await activeVersion(seeded.versionId)).toBeNull();
  });

  it("leaves no chunks and no active version when parsing fails", async () => {
    const { versionId, row } = await run(new Uint8Array([0xc3, 0x28]));
    expect(row.status).toBe("failed");
    expect(await storedChunks(versionId)).toEqual([]);
    expect(await activeVersion(versionId)).toBeNull();
  });

  it.each([
    ["encrypted PDF", buildEncryptedPdf(), "parse.encrypted"],
    ["truncated PDF", buildPdf(["Hello"]).subarray(0, 100), "parse.corrupt"],
    ["scanned PDF without text", buildPdf([""]), "parse.no_text"],
    ["invalid UTF-8", new Uint8Array([0xc3, 0x28]), "parse.invalid_encoding"],
    [
      "over the page limit",
      buildPdf(Array.from({ length: 101 }, (_, i) => `p${i}`)),
      "parse.too_many_pages",
    ],
    ["over the text limit", utf8("a".repeat(parseLimits.maxChars + 1)), "parse.text_too_large"],
    ["text bomb PDF", buildPdf(["x".repeat(parseLimits.maxChars + 1)]), "parse.text_too_large"],
  ] as const)("fails %s with its code recorded and no retry", async (_name, body, code) => {
    const { result, row } = await run(body);
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { stage: "parsing", code, retryable: false },
    });
    expect(row).toMatchObject({
      status: "failed",
      attempt: 1,
      error_stage: "parsing",
      error_code: code,
      error_retryable: false,
    });
  });

  it("fails a missing object and an oversized object with their own codes", async () => {
    expect((await run(null)).row).toMatchObject({
      status: "failed",
      error_code: "storage.missing",
    });
    const big = await run(new Uint8Array(parseLimits.maxInputBytes + 1).fill(97));
    expect(big.row).toMatchObject({ status: "failed", error_code: "storage.too_large" });
  });

  it("retries a storage outage within the attempt budget, then succeeds", async () => {
    const { versionId } = await seedWithObject(h, wsA, utf8("hello"));
    let outage = true;
    const flaky = pipeline(h, childPath, (real) => ({
      ...real,
      get: async (key, options) => {
        if (outage) throw new StorageError("storage.unavailable", true);
        return real.get(key, options);
      },
    }));
    const first = await flaky.process(wsA, versionId);
    expect(first).toMatchObject({ outcome: "retry", failure: { code: "storage.unavailable" } });
    expect(await h.row(versionId)).toMatchObject({ status: "queued", attempt: 1 });
    outage = false;
    await h.makeDue(versionId);
    expect(await flaky.process(wsA, versionId)).toEqual({ outcome: "processed" });
    expect(await h.row(versionId)).toMatchObject({ status: "ready", attempt: 2 });
  });

  it("makes a repeated delivery of a finished version a no-op", async () => {
    const { versionId, row } = await run(utf8("once"));
    const again = await pipeline(h, childPath).process(wsA, versionId);
    expect(again).toEqual({ outcome: "refused" });
    expect(await h.row(versionId)).toMatchObject({ attempt: row.attempt, status: "ready" });
  });

  it("stops without writing when the job is cancelled, and leaves the lease to recovery", async () => {
    const { versionId } = await seedWithObject(h, wsA, utf8("cancel me"));
    const controller = new AbortController();
    const flow = pipeline(h, childPath, (real) => ({
      ...real,
      get: async (key, options) => {
        controller.abort();
        return real.get(key, options);
      },
    }));
    expect(await flow.process(wsA, versionId, controller.signal)).toEqual({ outcome: "aborted" });
    expect(await h.row(versionId)).toMatchObject({
      status: "parsing",
      attempt: 1,
      error_code: null,
    });
    expect(flow.handoff.take({ versionId, leaseGeneration: 1 })).toBeUndefined();
  });

  it("never reads another workspace's object for a forged job", async () => {
    const { versionId } = await seedWithObject(h, wsA, utf8("tenant A only"));
    const forged = await pipeline(h, childPath).process(wsB, versionId);
    expect(forged).toEqual({ outcome: "refused" });
    expect(await h.row(versionId)).toMatchObject({ status: "uploaded", attempt: 0 });
    // Even past the claim, the read itself is confined to the job's workspace.
    const reads: string[] = [];
    await expect(
      readVersionBytes(
        {
          uow: h.worker.parseSourceUnitOfWork,
          store: {
            ...store,
            get: async (k) => {
              reads.push(k);
              return null;
            },
          },
        },
        { workspaceId: wsB, versionId, maxBytes: 10, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "document.unavailable" });
    expect(reads).toEqual([]);
  });

  it("does not parse a deleted document", async () => {
    const { versionId } = await seedWithObject(h, wsA, utf8("deleted"));
    await h.fx.fixture.query(
      "update documents set deleted_at = now() where id = (select document_id from document_versions where id = $1)",
      [versionId],
    );
    expect(await pipeline(h, childPath).process(wsA, versionId)).toEqual({ outcome: "refused" });
  });
});
