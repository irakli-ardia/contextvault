import { describe, expect, it } from "vitest";
import {
  activations,
  breakdown,
  classify,
  installProbe,
  summary,
} from "./ingestion-bench-probe.mjs";

describe("classify", () => {
  it.each([
    ["begin", "begin"],
    ["COMMIT", "commit"],
    ['insert into "chunks" ("id") values ($1)', "chunks"],
    ['insert into "chunk_embeddings" ("chunk_id") values ($1)', "embeddings"],
    ['insert into "sections" ("id") values ($1)', "sections"],
    ["update document_versions dv set status = 'ready', updated_at = now()", "markReady"],
    ["update documents d set active_version_id = $1", "movePointer"],
    ["select 1 from x for no key update of dv", "lockVersion"],
    ["select 1 from x for no key update of d", "lockDocument"],
    ["select 1", "other"],
  ])("labels %s", (text, label) => expect(classify(text)).toBe(label));
});

describe("summary", () => {
  it("uses the mean of the middle two as the median of an even count", () => {
    expect(summary([4, 1, 3, 2])).toMatchObject({ n: 4, min: 1, median: 2.5, max: 4, mean: 2.5 });
  });
  it("takes the nearest-rank p95 and survives an empty list", () => {
    expect(summary(Array.from({ length: 20 }, (_, i) => i + 1)).p95).toBe(19);
    expect(summary([])).toEqual({ n: 0 });
  });
});

describe("installProbe", () => {
  const fakeClient = () => {
    class Client {
      async query(config) {
        if (typeof config === "object" && config.text === "boom")
          throw Object.assign(new Error("x"), { code: "57014" });
        return { rows: [] };
      }
    }
    return Client;
  };

  it("records one transaction with per-label timings, a tag, and restores the original", async () => {
    const Client = fakeClient();
    const queryOf = () => Object.getOwnPropertyDescriptor(Client.prototype, "query")?.value;
    const original = queryOf();
    let tick = 0;
    const tickNext = () => {
      tick += 10;
      return tick;
    };
    const probe = installProbe(Client, { now: () => tickNext() }, () => 7);
    const client = new Client();
    for (const text of [
      "begin",
      'insert into "chunks" (a)',
      'insert into "chunks" (a)',
      "commit",
    ]) {
      await client.query({ text });
    }
    const [tx] = probe.transactions;
    expect(tx.tag).toBe(7);
    expect(tx.outcome).toBe("commit");
    expect(tx.labels.chunks).toEqual([10, 10]);
    expect(activations(probe.transactions)).toHaveLength(1);
    expect(breakdown(tx)).toMatchObject({
      activationTxMs: 70,
      chunkInsertClientMs: 20,
      chunkStatements: 2,
      commitClientMs: 10,
    });
    probe.restore();
    expect(queryOf()).toBe(original);
  });

  it("keeps the error code of a failed statement, ends the transaction, and still rejects", async () => {
    const Client = fakeClient();
    const probe = installProbe(Client);
    const client = new Client();
    await client.query({ text: "begin" });
    await expect(client.query({ text: "boom" })).rejects.toThrow("x");
    await client.query({ text: "rollback" });
    expect(probe.errors).toEqual([{ label: "other", code: "57014" }]);
    expect(probe.transactions[0].outcome).toBe("rollback");
    probe.restore();
  });
});
