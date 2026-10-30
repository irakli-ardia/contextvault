import { connect, createServer, type Server, type Socket } from "node:net";

export type ProxyMode = "forward" | "drop-replies" | "down";

/**
 * A TCP proxy in front of the test Redis. Tests flip it to simulate an outage (`down`: nothing
 * listens) or a lost acknowledgement (`drop-replies`: Redis receives and executes every command,
 * the client never hears back). Leaving a mode resets open connections, as a real outage would.
 */
export async function startRedisProxy(target: { host: string; port: number }) {
  let mode: ProxyMode = "forward";
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = connect(target.port, target.host);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("error", () => s.destroy());
      s.on("close", () => {
        sockets.delete(s);
        (s === client ? upstream : client).destroy();
      });
    }
    client.pipe(upstream);
    upstream.on("data", (chunk) => {
      if (mode === "forward") client.write(chunk);
    });
  });
  const listen = () => new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const closeServer = async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const s of sockets) s.destroy();
    await closed;
  };

  return {
    port,
    async setMode(next: ProxyMode) {
      const wasDown = mode === "down";
      mode = next;
      if (next === "down" && !wasDown) await closeServer();
      // Entering `drop-replies` keeps the open connection, so it can lose its next reply.
      else if (next !== "drop-replies") for (const s of sockets) s.destroy();
      if (wasDown && next !== "down") await listen();
    },
    async close() {
      if (mode === "down") return;
      mode = "down";
      await closeServer();
    },
  };
}
