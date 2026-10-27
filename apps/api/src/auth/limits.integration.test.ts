import { HashingBusy, type PasswordHasher } from "@contextvault/domain";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Account,
  type Api,
  createTenantFixture,
  password,
  seedAccount,
  startApi,
  webOrigin,
} from "../test-support";

// A hasher with no cost and no clock: "correct" is string equality with the test password, and
// `busy` simulates a full hashing queue, so limits are tested without sleeps or real hashing.
const hasher = (busy: boolean): PasswordHasher => ({
  hash: async () => "dummy",
  verify: async (candidate) => {
    if (busy) throw new HashingBusy();
    return candidate === password;
  },
  needsRehash: () => false,
});

const fx = await createTenantFixture(4);
afterAll(() => fx.close());

let api: Api;
let ada: Account;
const apps: Api[] = [];

async function start(busy = false) {
  api = await startApi({}, { hasher: hasher(busy) });
  apps.push(api);
  ada = await seedAccount(fx);
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.app.close()));
});

const attempt = (email: string, pw: string) =>
  api.http.post("/auth/login").set("Origin", webOrigin).send({ email, password: pw });
const bad = (email: string) => attempt(email, "wrong password entirely");

describe("hashing capacity", () => {
  beforeEach(() => start(true));

  it("answers a full hashing queue with a stable 429 that never escalates", async () => {
    const seen = [];
    for (let i = 0; i < 8; i++) seen.push(await attempt(ada.email, password));
    for (const res of seen) {
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBe("1");
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.body.error.code).toBe("auth.throttled");
      expect(Object.keys(res.body.error)).toEqual(["code", "requestId"]);
    }
    // Busy is not a failed login: it must not feed the account or IP counters.
    expect(new Set(seen.map((r) => r.headers["retry-after"]))).toEqual(new Set(["1"]));
  });
});

describe("limits", () => {
  beforeEach(() => start());

  it("blocks one account after 5 failures, for the right password too, and only that account", async () => {
    const other = await seedAccount(fx);
    for (let i = 0; i < 5; i++) expect((await bad(ada.email)).status).toBe(401);
    const blocked = await bad(ada.email);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("30");
    expect(blocked.body.error.code).toBe("auth.throttled");
    expect((await attempt(ada.email, password)).status).toBe(429);
    expect((await attempt(other.email, password)).status).toBe(200);
  });

  it("throttles an unknown email exactly like a known one", async () => {
    const unknown = "nobody@test.invalid";
    for (let i = 0; i < 5; i++) await bad(unknown);
    const blocked = await bad(unknown);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("30");
    expect(blocked.body.error.code).toBe("auth.throttled");
  });

  it("clears the account counter on success", async () => {
    for (let i = 0; i < 4; i++) await bad(ada.email);
    expect((await attempt(ada.email, password)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await bad(ada.email)).status).toBe(401);
  });

  it("blocks an address after 20 failures across accounts, and success does not reset it", async () => {
    const victim = await seedAccount(fx);
    for (let i = 0; i < 19; i++) expect((await bad(`n${i}@test.invalid`)).status).toBe(401);
    // A success in between clears only the account key.
    expect((await attempt(victim.email, password)).status).toBe(200);
    expect((await bad("n19@test.invalid")).status).toBe(401);
    const blocked = await attempt(victim.email, password);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("900");
  });

  it("does not let a spoofed X-Forwarded-For move the address bucket (hops = 0)", async () => {
    for (let i = 0; i < 20; i++) {
      await api.http
        .post("/auth/login")
        .set("Origin", webOrigin)
        .set("X-Forwarded-For", `198.51.100.${i}`)
        .send({ email: `s${i}@test.invalid`, password: "wrong password entirely" });
    }
    const res = await api.http
      .post("/auth/login")
      .set("Origin", webOrigin)
      .set("X-Forwarded-For", "203.0.113.200")
      .send({ email: ada.email, password });
    expect(res.status).toBe(429);
  });
});
