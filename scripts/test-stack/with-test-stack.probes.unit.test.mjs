import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST } from "./with-test-stack.fixtures.mjs";
import { createProbes, PROBE_ENV, quote, runProbe } from "./with-test-stack.probes.mjs";

const HOSTILE = {
  HTTP_PROXY: "http://evil:8080",
  https_proxy: "http://evil:8080",
  ALL_PROXY: "socks5://evil:1080",
  PGHOST: "dev-db",
  PGPORT: "5432",
  PGOPTIONS: "-c search_path=x",
  PGSSLMODE: "require",
  AWS_ACCESS_KEY_ID: "dev-aws",
  AWS_PROFILE: "dev",
  CURL_HOME: "/dev-home",
  HOME: "/dev-home",
  NODE_OPTIONS: "--require /x",
};
const servers = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) server.close();
});
const listen = (onConnection) =>
  new Promise((resolve) => {
    const server = createServer(onConnection).listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve(server.address().port);
    });
  });

describe("probe environment", () => {
  it("is PATH alone, whatever the parent holds", async () => {
    for (const [key, value] of Object.entries(HOSTILE)) vi.stubEnv(key, value);
    const out = await runProbe(
      process.execPath,
      ["-e", "console.log(JSON.stringify(process.env))"],
      "",
    );
    const seen = Object.keys(JSON.parse(out)).filter((k) => k !== "__CF_USER_TEXT_ENCODING");
    expect(seen).toEqual(Object.keys(PROBE_ENV));
  });

  it("feeds credentials by stdin, never by argument or environment", async () => {
    const out = await runProbe(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)", "visible-arg"],
      "from-stdin",
    );
    expect(out).toBe("from-stdin");
  });
});

describe("PostgreSQL probe", () => {
  it("is killed at its timeout and releases its connection", async () => {
    const closes = [];
    const port = await listen((socket) => {
      socket.on("error", () => {});
      socket.resume(); // an unread socket never notices the peer closing
      closes.push(new Promise((resolve) => socket.on("close", resolve)));
    });
    const url = TEST.DATABASE_URL.replace(":55433", `:${port}`);
    const started = Date.now();
    await expect(createProbes(1500).postgres(url)).rejects.toThrow("probe failed");
    // The child's own connect timeout is 5 s, so ending earlier means the kill did it.
    expect(Date.now() - started).toBeLessThan(4000);
    // If the child got as far as connecting, its death closed the socket.
    await Promise.all(closes);
  }, 10_000);

  it("rejects without a message that could carry connection detail", async () => {
    const port = await listen((socket) => socket.destroy());
    const url = TEST.DATABASE_URL.replace(":55433", `:${port}`);
    const error = await createProbes(2000)
      .postgres(url)
      .catch((e) => e);
    expect(error.message).toBe("probe failed");
  });
});

describe("S3 probe", () => {
  it("passes a 200 and rejects anything else, ignoring a hostile proxy", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("http_proxy", "http://127.0.0.1:1");
    let status = 200;
    const port = await listen((socket) => {
      socket.on("data", () => socket.end(`HTTP/1.1 ${status} X\r\ncontent-length: 0\r\n\r\n`));
    });
    const env = { ...TEST, S3_ENDPOINT: `http://127.0.0.1:${port}` };
    await expect(createProbes(3000).s3(env)).resolves.toBeUndefined();
    status = 403;
    await expect(createProbes(3000).s3(env)).rejects.toThrow();
  });

  it("sends a secret with quotes and backslashes intact, without it appearing in a request line", async () => {
    const seen = [];
    const port = await listen((socket) => {
      socket.on("data", (chunk) => {
        seen.push(String(chunk));
        socket.end("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
      });
    });
    const secret = 'se"cr\\et';
    const env = { ...TEST, S3_SECRET_ACCESS_KEY: secret, S3_ENDPOINT: `http://127.0.0.1:${port}` };
    await createProbes(3000).s3(env);
    expect(seen.join("")).toMatch(/Authorization: AWS4-HMAC-SHA256 Credential=test-key-id\//);
    expect(seen.join("")).not.toContain(secret);
  });
});

describe("curl config quoting", () => {
  it("escapes backslash, quote and control characters, nothing else", () => {
    expect(quote('a"b\\c\nd\re\tf\vg')).toBe('a\\"b\\\\c\\nd\\re\\tf\\vg');
    expect(quote("plain/+=:")).toBe("plain/+=:");
  });
});
