import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  type Api,
  createTenantFixture,
  seedAccount,
  startApi,
} from "../test-support";
import { listen, pdfBytes, purge, rows, signedIn, startUpload, upload } from "./upload-support";

const fx = createTenantFixture(4);
let api: Api;
let ada: { account: Account; workspaceId: string; token: string };
let bea: { account: Account; workspaceId: string; token: string };
const body = pdfBytes(300, 0x51);

beforeAll(async () => {
  api = await startApi();
  await listen(api);
  ada = await signedIn(api, fx, () => seedAccount(fx));
  bea = await signedIn(api, fx, () => seedAccount(fx));
});
afterAll(async () => {
  await api.app.close();
  await fx.close();
});

const refused = (res: Awaited<ReturnType<typeof upload>>, status: number, code: string) => {
  expect([res.status, res.json.error?.code]).toEqual([status, code]);
  // Answered before the body was read: the connection must not stay open for it.
  expect(res.headers.connection).toBe("close");
};

describe("upload authentication and authorization", () => {
  it("closes the connection after refusing a request whose body it never read", async () => {
    // Keep-alive is requested explicitly: only the server's `Connection: close` can end it.
    const sending = startUpload(
      api,
      {
        workspaceId: ada.workspaceId,
        declared: 1024 * 1024,
        headers: { connection: "keep-alive" },
      },
      Buffer.alloc(64 * 1024, 0x41),
    );
    const res = await sending.result;
    expect([res.status, res.headers.connection]).toEqual([401, "close"]);
    const verdict = await Promise.race([
      sending.closed.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("still open"), 3_000)),
    ]);
    expect(verdict).toBe("closed");
    sending.abort();
  });

  it("rejects a missing, unknown or revoked session, and stores nothing", async () => {
    const { workspaceId } = ada;
    refused(await upload(api, { workspaceId }, body), 401, "auth.unauthenticated");
    refused(
      await upload(api, { workspaceId, token: "x".repeat(43) }, body),
      401,
      "auth.unauthenticated",
    );
    await fx.owner.query("update sessions set revoked_at = now() where user_id = $1", [
      bea.account.id,
    ]);
    refused(
      await upload(api, { ...bea, workspaceId: bea.workspaceId }, body),
      401,
      "auth.unauthenticated",
    );
    expect(await rows(fx, workspaceId)).toEqual({ documents: 0, versions: 0, pending: 0 });
  });

  it("rejects a missing, foreign or malformed Origin", async () => {
    for (const origin of [null, "https://evil.example", "null", `${"http://127.0.0.1:3000"}/`]) {
      refused(await upload(api, { ...ada, origin }, body), 403, "request.forbidden_origin");
    }
    expect(await rows(fx, ada.workspaceId)).toEqual({ documents: 0, versions: 0, pending: 0 });
  });

  it("answers a foreign, unknown and malformed workspace identically", async () => {
    const answers = [];
    for (const workspaceId of [
      bea.workspaceId,
      "6f1c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5",
      "not-a-uuid",
    ]) {
      const res = await upload(api, { token: ada.token, workspaceId }, body);
      refused(res, 404, "not_found");
      answers.push(res.text.replace(/"requestId":"[^"]+"/, ""));
    }
    expect(new Set(answers).size).toBe(1);
    expect(await rows(fx, bea.workspaceId)).toEqual({ documents: 0, versions: 0, pending: 0 });
  });

  it("stops a revoked member from uploading", async () => {
    const carl = await signedIn(api, fx, () => seedAccount(fx));
    await fx.owner.query(
      "insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member')",
      [ada.workspaceId, carl.account.id],
    );
    const options = { token: carl.token, workspaceId: ada.workspaceId };
    expect((await upload(api, options, body)).status).toBe(201);
    await fx.owner.query("delete from memberships where workspace_id = $1 and user_id = $2", [
      ada.workspaceId,
      carl.account.id,
    ]);
    refused(
      await upload(api, { ...options, name: "again.pdf" }, pdfBytes(10, 0x52)),
      404,
      "not_found",
    );
    await purge(api, fx, ada.workspaceId);
  });

  it("ignores a client-supplied user id, storage key or URL", async () => {
    const hostile = {
      "x-user-id": bea.account.id,
      "x-storage-key": "ws/other",
      "x-forwarded-for": "9.9.9.9",
    };
    const sending = startUpload(api, { ...ada, declared: body.length, headers: hostile });
    sending.end(body);
    const res = await sending.result;
    expect(res.status).toBe(201);
    const [row] = (
      await fx.owner.query(
        "select d.created_by, v.storage_key from documents d join document_versions v on v.document_id = d.id where d.id = $1",
        [res.json.id],
      )
    ).rows;
    expect(row.created_by).toBe(ada.account.id);
    expect(row.storage_key.startsWith(`ws/${ada.workspaceId}/doc/${res.json.id}/v/`)).toBe(true);
    await purge(api, fx, ada.workspaceId);
  });
});
