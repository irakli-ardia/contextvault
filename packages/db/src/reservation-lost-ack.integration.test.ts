import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import { loadDatabaseEnv } from "@contextvault/config";
import {
  type DocumentStore,
  type UploadServices,
  type UserId,
  uploadDocument,
  type WorkspaceId,
} from "@contextvault/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPersistence } from "./persistence";
import { createTenantFixture } from "./tenant-fixture";

// A relay between the app and the real PostgreSQL that, once armed, forwards the next COMMIT,
// swallows the database's answer and then cuts the client side: the database has committed (its
// answer proves it), the application never hears of it. Cutting before that answer would let the
// test read the table before PostgreSQL ran the COMMIT.
function startRelay(target: URL) {
  let armed = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: target.hostname, port: Number(target.port) });
    let swallowing = false;
    sockets.add(client).add(upstream);
    client.on("data", (data) => {
      upstream.write(data);
      if (armed && data.toString("latin1").toLowerCase().includes("commit")) {
        armed = false;
        swallowing = true;
      }
    });
    upstream.on("data", (data) => {
      if (swallowing) client.destroy();
      else client.write(data);
    });
    for (const socket of [client, upstream]) {
      socket.on("error", () => undefined);
      socket.on("close", () => {
        sockets.delete(socket);
        socket.destroy();
        (socket === client ? upstream : client).destroy();
      });
    }
  });
  return {
    arm: () => {
      armed = true;
    },
    listen: () =>
      new Promise<number>((resolve, reject) =>
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") reject(new Error("no port"));
          else resolve(address.port);
        }),
      ),
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

const fx = createTenantFixture(4);
const services: UploadServices = {
  newId: randomUUID,
  newSha256() {
    const hash = createHash("sha256");
    return { update: (chunk) => void hash.update(chunk), digest: () => hash.digest() };
  },
};
const relay = startRelay(new URL(loadDatabaseEnv().DATABASE_URL));
let proxied: ReturnType<typeof createPersistence>;
let user: UserId;
let stranger: UserId;
let ws: WorkspaceId;

beforeAll(async () => {
  const url = new URL(loadDatabaseEnv().DATABASE_URL);
  url.hostname = "127.0.0.1";
  url.port = String(await relay.listen());
  proxied = createPersistence({ connectionString: url.toString(), poolSize: 2 });
  user = await fx.seedUser();
  stranger = await fx.seedUser();
  ws = await fx.createWorkspace(user);
});
afterAll(async () => {
  relay.close();
  await proxied.close();
  await fx.close();
});

describe("a reservation whose commit acknowledgement is lost", () => {
  it("is durable, is reported once, and nothing reaches storage", async () => {
    const put = vi.fn();
    const remove = vi.fn();
    const store: DocumentStore = { put, head: vi.fn(), delete: remove };
    const onRetained = vi.fn();
    relay.arm();
    const result = await uploadDocument(
      { uow: proxied.unitOfWork, store, services, onRetained },
      {
        actor: { userId: user, workspaceId: ws, role: "owner" },
        fileName: "a.pdf",
        contentType: "application/pdf",
        declaredBytes: 12,
        body: (async function* () {
          yield Buffer.from("%PDF-1.7 abcd");
        })(),
      },
    ).catch((e: unknown) => e);

    expect(result).toMatchObject({ code: "transaction.outcome_unknown" });
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    const rows = (
      await fx.owner.query("select id from pending_uploads where workspace_id = $1", [ws])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(onRetained).toHaveBeenCalledTimes(1);
    expect(onRetained).toHaveBeenCalledWith({ workspaceId: ws, versionId: rows[0].id });
    // Discoverable by the workspace's members, invisible to anyone else.
    const mine = await fx.queryAs(
      { userId: user, workspaceId: ws },
      "select id from pending_uploads",
    );
    const theirs = await fx.queryAs(
      { userId: stranger, workspaceId: ws },
      "select id from pending_uploads",
    );
    expect([mine.length, theirs.length]).toEqual([1, 0]);
  });
});
