import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { infraRoles } from "./infra-roles.mjs";

// No Docker here: `docker` is a recording fake, so these tests cannot reach any database. Every
// refusal must happen before the single call that carries SQL (the only call with `input`).
const SQL = "-- the roles.sql text\nselect 1;\n";
const OWNER_PW = "owner-secret-1";
const FIXTURE_PW = "fixture-secret-2";
const ENV = [
  "NODE_ENV=development",
  "POSTGRES_USER=boot",
  "POSTGRES_DB=appdb",
  `POSTGRES_OWNER_PASSWORD=${OWNER_PW}`,
  `POSTGRES_FIXTURE_PASSWORD=${FIXTURE_PW}`,
].join("\n");
const SYSID = "7311111111111111111";
const TOKEN = `proj/appdb@${SYSID}`;

function run(argv, over = {}) {
  const calls = [];
  const world = {
    dotenv: ENV,
    container: "abc123def456",
    labels: {
      "com.docker.compose.project": "proj",
      "com.docker.compose.project.config_files": "/repo/infra/compose.yaml",
    },
    containerEnv: "appdb|boot",
    probe: `appdb|on|18.6|${SYSID}|2|8`,
    applyStatus: 0,
    ...over,
  };
  const docker = (args, input) => {
    calls.push({ args, input });
    const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
    if (args.includes("ps")) {
      return world.psStatus
        ? { status: world.psStatus, stdout: "", stderr: "" }
        : ok(`${world.container}\n`);
    }
    if (args[0] === "inspect") return ok(JSON.stringify(world.labels));
    if (input === undefined) return ok(`${world.containerEnv}\n${world.probe}\n`);
    return {
      status: world.applyStatus,
      stdout: `applied ${OWNER_PW}\n`,
      stderr: `${FIXTURE_PW}\n`,
    };
  };
  const result = infraRoles({
    argv,
    readFile: (path) => {
      if (path === ".env") {
        if (world.dotenv === null) throw new Error("ENOENT");
        return world.dotenv;
      }
      return SQL;
    },
    realpath: (path) => path.replace(/^infra\//, "/repo/infra/"),
    docker,
  });
  return { ...result, calls, sqlCalls: calls.filter((call) => call.input !== undefined) };
}

const target = ["--project=proj"];
const confirmed = [...target, `--confirm=${TOKEN}`];

describe("refusals before any Docker call", () => {
  it.each([
    ["no project named", []],
    ["an unknown argument", [...target, "--yes"]],
    ["a malformed project name", ["--project=Bad Name"]],
    ["a bare word instead of --project", ["proj"]],
  ])("%s: usage error", (_name, argv) => {
    const r = run(argv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Usage:");
    expect(r.calls).toEqual([]);
  });

  it("a missing .env", () => {
    const r = run(confirmed, { dotenv: null });
    expect([r.code, r.stderr]).toEqual([1, expect.stringContaining("No .env")]);
    expect(r.calls).toEqual([]);
  });

  it("NODE_ENV=production", () => {
    const r = run(confirmed, { dotenv: `${ENV}\nNODE_ENV=production` });
    expect([r.code, r.stderr]).toEqual([1, expect.stringContaining("production")]);
    expect(r.calls).toEqual([]);
  });

  it.each(["POSTGRES_OWNER_PASSWORD", "POSTGRES_FIXTURE_PASSWORD"])("apply without %s", (name) => {
    const r = run(confirmed, { dotenv: ENV.replace(new RegExp(`${name}=.*`), `${name}=`) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(name);
    expect(r.calls).toEqual([]);
  });
});

describe("refusals about the container and server (no SQL-carrying call)", () => {
  const refused = (r, text, code = 1) => {
    expect(r.code).toBe(code);
    expect(r.stderr).toContain(text);
    expect(r.sqlCalls).toEqual([]);
  };

  it.each(["", "12a4", "1; touch /tmp/x", "-1", "1.5"])(
    "a system identifier that is not decimal digits (%j)",
    (id) => {
      const r = run(confirmed, { probe: `appdb|on|18.6|${id}|2|8` });
      refused(r, "system identifier"); // sqlCalls empty: nothing was interpolated
    },
  );

  it("a stopped or missing service, or Docker failing", () => {
    refused(run(confirmed, { container: "" }), "not running");
    refused(run(confirmed, { psStatus: 1 }), "not running");
  });

  it("the wrong Compose project (labels name another project)", () => {
    refused(
      run(confirmed, {
        labels: {
          "com.docker.compose.project": "other",
          "com.docker.compose.project.config_files": "/repo/infra/compose.yaml",
        },
      }),
      "does not belong to project proj",
    );
  });

  it("the wrong checkout (container started from another compose file)", () => {
    refused(
      run(confirmed, {
        labels: {
          "com.docker.compose.project": "proj",
          "com.docker.compose.project.config_files": "/elsewhere/infra/compose.yaml",
        },
      }),
      "not started from this checkout",
    );
  });

  it("a database identity mismatch between .env and the container", () => {
    refused(run(confirmed, { containerEnv: "otherdb|boot" }), "differ from the running container");
    refused(run(confirmed, { containerEnv: "appdb|someone" }), "differ from the running container");
  });

  it("a server that does not report a superuser", () => {
    refused(run(confirmed, { probe: `appdb|off|18.6|${SYSID}|2|8` }), "not a superuser");
  });
});

describe("refusals on the token and on rollback (no SQL-carrying call)", () => {
  const refused = (r, text, code = 1) => {
    expect(r.code).toBe(code);
    expect(r.stderr).toContain(text);
    expect(r.sqlCalls).toEqual([]);
  };

  it("a server identity mismatch (token from another server, database or project)", () => {
    for (const token of [
      `proj/appdb@${SYSID.slice(0, -1)}9`,
      `proj/other@${SYSID}`,
      `other/appdb@${SYSID}`,
      "",
    ]) {
      refused(run([...target, `--confirm=${token}`]), "does not match this server");
    }
  });

  it("rollback on a server without both transition roles, even with the right token", () => {
    for (const roles of ["0", "1"]) {
      refused(
        run(["rollback", ...confirmed], { probe: `appdb|on|18.6|${SYSID}|${roles}|8` }),
        "rollback needs both transition roles",
      );
    }
  });

  it("no confirmation token: a dry run that prints the token and changes nothing", () => {
    const r = run(target);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain(`--project=proj --confirm=${TOKEN}`);
    expect(r.stdout).toContain("Nothing changed");
    expect(r.sqlCalls).toEqual([]);
  });

  it("every refusal path used read-only calls only", () => {
    const calls = [
      run(target).calls,
      run(confirmed, { containerEnv: "x|y" }).calls,
      run(["rollback", ...confirmed], { probe: `appdb|on|18.6|${SYSID}|0|8` }).calls,
    ].flat();
    const sql = calls.map((call) => call.args.join(" ")).join("\n");
    expect(sql).not.toMatch(/\b(insert|update|delete|alter|create|drop|grant|revoke|truncate)\b/i);
  });
});

describe("a confirmed request", () => {
  it("makes exactly one SQL-carrying call: project pinned, identity re-checked, secrets off the command line", () => {
    const r = run(confirmed);
    expect(r.code).toBe(0);
    expect(r.sqlCalls).toHaveLength(1);
    const { args, input } = r.sqlCalls[0];
    expect(args.slice(0, 3)).toEqual(["compose", "-p", "proj"]);
    expect(args.join(" ")).toContain(`expect_system_identifier=${SYSID}`);
    expect(args.join(" ")).not.toContain("rollback=1");
    expect(args.join(" ")).not.toMatch(/secret/);
    expect(input).toBe(`${OWNER_PW}\n${FIXTURE_PW}\n${SQL}`);
    expect(r.stdout + r.stderr).not.toMatch(/secret/);
    expect(r.stdout).toContain("roles up to date");
  });

  it("every Docker call names the project explicitly", () => {
    for (const call of run(confirmed).calls.filter((c) => c.args[0] === "compose")) {
      expect(call.args.slice(0, 3)).toEqual(["compose", "-p", "proj"]);
    }
  });

  it("rollback carries rollback=1 and needs no passwords", () => {
    const r = run(["rollback", ...confirmed], {
      dotenv: "NODE_ENV=development\nPOSTGRES_USER=boot\nPOSTGRES_DB=appdb",
    });
    expect(r.code).toBe(0);
    expect(r.sqlCalls[0].args.join(" ")).toContain("-v rollback=1");
    expect(r.stdout).toContain("roles rolled back");
  });

  it("a failing apply surfaces the exit code", () => {
    expect(run(confirmed, { applyStatus: 3 }).code).toBe(3);
  });
});

describe("command line entry", () => {
  // Spawned: a guard that never fires (`import.meta.main` on old Node) exits 0 silently. Refuses before Docker.
  it("runs, and refuses a call without --project", () => {
    const run = spawnSync(
      process.execPath,
      [new URL("./infra-roles.mjs", import.meta.url).pathname],
      {
        encoding: "utf8",
      },
    );
    expect([run.status, run.stderr]).toEqual([2, expect.stringContaining("Usage:")]);
  });
});
