import { vi } from "vitest";
import { proxyUpload } from "./upload-proxy";

// Shared builders for the upload-proxy unit tests. `source` counts how far the proxy reads ahead.
export const id = "0f6c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5";
export const upstreamOrigin = "http://127.0.0.1:3001";
export const chunkSize = 64 * 1024;

export type Fetch = typeof fetch;

/** A body whose `pull` count shows how far ahead of the consumer the proxy reads. */
export function source(chunks: number, size = chunkSize) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) return controller.close();
      pulled++;
      controller.enqueue(new Uint8Array(size));
    },
  });
  return { stream, pulled: () => pulled };
}

export function upload(
  headers: Record<string, string> = {},
  body: ReadableStream<Uint8Array>,
  length?: number,
  signal?: AbortSignal,
) {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    duplex: "half",
    body,
    ...(signal === undefined ? {} : { signal }),
    headers: {
      "content-type": "application/pdf",
      "content-length": String(length ?? chunkSize),
      "x-filename": "a.pdf",
      ...headers,
    },
  };
  return new Request(`http://web.test/api/workspaces/${id}/uploads`, init);
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

export async function drain(init: RequestInit | undefined): Promise<number> {
  if (!(init?.body instanceof ReadableStream)) throw new Error("no body");
  const reader = init.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
  }
}

export const run = (request: Request, fetchImpl: Fetch, workspaceId = id) =>
  proxyUpload(request, workspaceId, {
    upstreamOrigin,
    fetch: fetchImpl,
    newRequestId: () => "req-1",
  });

export const reading = (response: Response = json(201, { ok: true })): Fetch =>
  vi.fn<Fetch>(async (_url, init) => {
    await drain(init);
    return response;
  });
