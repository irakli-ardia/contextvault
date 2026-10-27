import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { DocumentStore, StorageKey } from "@contextvault/domain";
import { Logger } from "@nestjs/common";
import { vi } from "vitest";
import { DOCUMENT_STORE } from "../storage/tokens";
import {
  type Account,
  type Api,
  type createTenantFixture,
  loginAs,
  webOrigin,
} from "../test-support";

type TenantFixture = ReturnType<typeof createTenantFixture>;

/** `startApi` only initialises; the raw client needs a socket. */
export const listen = (api: Api) => api.app.listen(0, "127.0.0.1");

export const pdfBytes = (size = 2048, fill = 0x41) =>
  Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(size, fill)]);

export interface Sent {
  readonly status: number;
  readonly json: { error?: { code: string; requestId: string }; id?: string; displayName?: string };
  readonly headers: http.IncomingHttpHeaders;
  readonly text: string;
}

export interface UploadOptions {
  readonly workspaceId: string;
  readonly token?: string | undefined;
  readonly origin?: string | null;
  readonly name?: string;
  readonly type?: string;
  readonly declared?: number;
  readonly headers?: Record<string, string>;
}

// A raw HTTP client, so the test decides exactly which bytes leave and when: Supertest buffers.
export function startUpload(api: Api, options: UploadOptions, first?: Buffer) {
  const address: AddressInfo | string | null = api.app.getHttpServer().address();
  if (address === null || typeof address === "string") throw new Error("API is not listening");
  const headers: Record<string, string> = {
    "content-type": options.type ?? "application/pdf",
    "x-filename": encodeURIComponent(options.name ?? "report.pdf"),
    ...options.headers,
  };
  const optional: Record<string, string | undefined> = {
    "content-length": options.declared === undefined ? undefined : String(options.declared),
    cookie: options.token === undefined ? undefined : `cv_session=${options.token}`,
    origin: options.origin === null ? undefined : (options.origin ?? webOrigin),
  };
  for (const [name, value] of Object.entries(optional))
    if (value !== undefined) headers[name] = value;
  const handle: { req?: http.ClientRequest } = {};
  const result = new Promise<Sent>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: `/workspaces/${options.workspaceId}/uploads`,
        method: "POST",
        headers,
        agent: false,
      },
      (res) => {
        let text = "";
        res.on("data", (d: Buffer) => {
          text += d.toString();
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            json: text === "" ? {} : JSON.parse(text),
            headers: res.headers,
            text,
          }),
        );
      },
    );
    req.on("error", reject);
    handle.req = req;
  });
  void result.catch(() => undefined);
  const req = (): http.ClientRequest => {
    if (handle.req === undefined) throw new Error("request not created");
    return handle.req;
  };
  if (first !== undefined) req().write(first);
  return {
    result,
    write: (chunk: Buffer) => req().write(chunk),
    end: (chunk?: Buffer) => req().end(chunk),
    /** Drops the connection mid-body, like a closed tab. */
    abort: () => req().destroy(),
    /** Resolves when the server has closed the connection. */
    closed: new Promise<void>((resolve) => req().once("close", () => resolve())),
  };
}

/** One whole upload in one call. */
export async function upload(api: Api, options: UploadOptions, body: Buffer): Promise<Sent> {
  const sending = startUpload(api, { declared: body.length, ...options });
  sending.end(body);
  return sending.result;
}

export async function signedIn(api: Api, fx: TenantFixture, seed: () => Promise<Account>) {
  const account = await seed();
  const workspaceId = await fx.createWorkspace(account.id, "Uploads");
  const { token } = await loginAs(api, account);
  return { account, workspaceId, token };
}

export interface Rows {
  documents: number;
  versions: number;
  pending: number;
}

export async function rows(fx: TenantFixture, workspaceId: string): Promise<Rows> {
  const count = async (table: string) =>
    Number(
      (await fx.owner.query(`select count(*) from ${table} where workspace_id = $1`, [workspaceId]))
        .rows[0].count,
    );
  return {
    documents: await count("documents"),
    versions: await count("document_versions"),
    pending: await count("pending_uploads"),
  };
}

export const store = (api: Api): DocumentStore => api.app.get(DOCUMENT_STORE);

export async function storedKeys(fx: TenantFixture, workspaceId: string): Promise<StorageKey[]> {
  const found = await fx.owner.query(
    "select storage_key from document_versions where workspace_id = $1 union select storage_key from pending_uploads where workspace_id = $1",
    [workspaceId],
  );
  return found.rows.map((row: { storage_key: StorageKey }) => row.storage_key);
}

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Everything Nest's Logger receives, as one string (to prove nothing sensitive is in it). */
export function captureLogs() {
  const lines: string[] = [];
  const record = (message: unknown) => {
    lines.push(String(message));
  };
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(record);
  }
  return lines;
}

/** Removes a workspace's objects and document rows (test cleanup; the bucket is shared). */
export async function purge(api: Api, fx: TenantFixture, workspaceId: string): Promise<void> {
  for (const key of await storedKeys(fx, workspaceId)) await store(api).delete(key);
  await fx.owner.query("delete from pending_uploads where workspace_id = $1", [workspaceId]);
  await fx.owner.query("delete from document_versions where workspace_id = $1", [workspaceId]);
  await fx.owner.query("delete from documents where workspace_id = $1", [workspaceId]);
}

/** A value that must exist (indexed access under `noUncheckedIndexedAccess`). */
export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}
