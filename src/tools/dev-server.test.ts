import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerDevServer,
  ensureDevServerRunning,
  stopDevServer,
  stopIdleDevServers,
  stopAllDevServers,
  readDevServerRecord,
  devConnectorName,
  appServeBackendTool,
  type DevServerDeps,
} from "./dev-server.js";
import { clearDevServerActivity, devServerActivity } from "./dev-server-access.js";

let tmpLax: string;
let prevDataDir: string | undefined;

// Fake process control so no real dev server is spawned. sessionId → alive.
function fakeDeps(): { deps: Required<DevServerDeps>; sessions: Map<string, boolean>; starts: string[] } {
  const sessions = new Map<string, boolean>();
  const starts: string[] = [];
  let n = 0;
  const deps: Required<DevServerDeps> = {
    start: (command) => { const id = `s${++n}`; sessions.set(id, true); starts.push(command); return { session: { sessionId: id } }; },
    isAlive: (sid) => sessions.get(sid) === true,
    kill: (sid) => { sessions.set(sid, false); },
  };
  return { deps, sessions, starts };
}

beforeEach(() => {
  tmpLax = mkdtempSync(join(tmpdir(), "lax-devsrv-"));
  prevDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = tmpLax;
  clearDevServerActivity();   // the activity map is module-level — isolate tests
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
  rmSync(tmpLax, { recursive: true, force: true });
});

const connectorFile = (name: string) => join(tmpLax, "connectors", `${name}.json`);

describe("registerDevServer — wires connector + record + starts the process", () => {
  it("writes a localhost connector manifest, persists a record, and starts the command", () => {
    const { deps, starts } = fakeDeps();
    const r = registerDevServer({ appId: "notes", command: "node server.js", port: 5180, cwd: "/tmp/notes/server" }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.connector).toBe("dev-notes");
    expect(starts).toEqual(["node server.js"]);

    const manifest = JSON.parse(readFileSync(connectorFile("dev-notes"), "utf8"));
    expect(manifest.upstream).toBe("http://localhost:5180");
    expect(manifest.auth.type).toBe("none");
    expect(manifest.allow).toContain("GET /*");

    const rec = readDevServerRecord("notes");
    expect(rec?.command).toBe("node server.js");
    expect(rec?.port).toBe(5180);
    expect(rec?.sessionId).toBe(r.sessionId);
  });

  it("defaults cwd to the app ROOT (not /server) so `cd server` in the command works", () => {
    const { deps } = fakeDeps();
    registerDevServer({ appId: "myapp", command: "cd server && npm run dev", port: 5190 }, deps);  // no cwd
    const rec = readDevServerRecord("myapp");
    expect(rec?.cwd.endsWith(join("apps", "myapp"))).toBe(true);
    expect(rec?.cwd.endsWith(join("myapp", "server"))).toBe(false);
  });

  it("rejects a missing/invalid port without writing anything", () => {
    const { deps } = fakeDeps();
    const r = registerDevServer({ appId: "x", command: "node s.js", port: 0, cwd: "/tmp/x" }, deps);
    expect(r.ok).toBe(false);
    expect(existsSync(connectorFile("dev-x"))).toBe(false);
    expect(readDevServerRecord("x")).toBeNull();
  });

  it("restarts (kills the old session) when re-registering a live app", () => {
    const { deps, sessions } = fakeDeps();
    const first = registerDevServer({ appId: "notes", command: "v1", port: 5180, cwd: "/tmp/x" }, deps);
    expect(first.ok && first.restarted).toBe(false);
    const firstId = first.ok ? first.sessionId : "";

    const second = registerDevServer({ appId: "notes", command: "v2", port: 5180, cwd: "/tmp/x" }, deps);
    expect(second.ok && second.restarted).toBe(true);
    expect(sessions.get(firstId)).toBe(false);            // old killed
    expect(readDevServerRecord("notes")?.command).toBe("v2");
  });
});

describe("ensureDevServerRunning — lazy start-on-access", () => {
  it("returns 'none' for an app with no registered backend", () => {
    const { deps } = fakeDeps();
    expect(ensureDevServerRunning("never-registered", deps).status).toBe("none");
  });

  it("is a no-op when the session is already alive", () => {
    const { deps, starts } = fakeDeps();
    registerDevServer({ appId: "notes", command: "node s.js", port: 5180, cwd: "/tmp/x" }, deps);
    const res = ensureDevServerRunning("notes", deps);
    expect(res.status).toBe("running");
    expect(starts).toHaveLength(1);                        // not restarted
  });

  it("restarts a dead backend (the survives-restart path) and updates the record", () => {
    const { deps, sessions } = fakeDeps();
    const reg = registerDevServer({ appId: "notes", command: "node s.js", port: 5180, cwd: "/tmp/x" }, deps);
    const oldId = reg.ok ? reg.sessionId : "";
    sessions.set(oldId, false);                            // simulate server restart wiping the process

    const res = ensureDevServerRunning("notes", deps);
    expect(res.status).toBe("started");
    if (res.status === "started") expect(res.record.sessionId).not.toBe(oldId);
    expect(readDevServerRecord("notes")?.sessionId).not.toBe(oldId);
  });
});

describe("stopDevServer — plain stop vs forget-on-delete", () => {
  it("forget removes the connector + record and kills the session", () => {
    const { deps, sessions } = fakeDeps();
    const reg = registerDevServer({ appId: "notes", command: "node s.js", port: 5180, cwd: "/tmp/x" }, deps);
    const id = reg.ok ? reg.sessionId : "";

    stopDevServer("notes", deps, { forget: true });
    expect(sessions.get(id)).toBe(false);
    expect(existsSync(connectorFile("dev-notes"))).toBe(false);
    expect(readDevServerRecord("notes")).toBeNull();
  });

  it("plain stop kills the session but keeps the record for a later lazy restart", () => {
    const { deps, sessions } = fakeDeps();
    const reg = registerDevServer({ appId: "notes", command: "node s.js", port: 5180, cwd: "/tmp/x" }, deps);
    const id = reg.ok ? reg.sessionId : "";

    stopDevServer("notes", deps);
    expect(sessions.get(id)).toBe(false);
    expect(readDevServerRecord("notes")?.command).toBe("node s.js");  // record kept
  });
});

describe("idle auto-stop + shutdown cleanup (so a backend doesn't run forever)", () => {
  it("stopIdleDevServers kills a backend past the idle window but KEEPS its record", () => {
    const { deps, sessions } = fakeDeps();
    const reg = registerDevServer({ appId: "stale", command: "x", port: 5191, cwd: "/tmp/x" }, deps);
    const id = reg.ok ? reg.sessionId : "";

    const stopped = stopIdleDevServers(0, Date.now() + 1000, deps);  // window 0 → idle
    expect(stopped).toContain("stale");
    expect(sessions.get(id)).toBe(false);                  // process killed
    expect(readDevServerRecord("stale")).not.toBeNull();   // record kept → reopening restarts it
    expect(devServerActivity().has("stale")).toBe(false);  // dropped from the active set
  });

  it("stopIdleDevServers leaves a freshly-used backend running", () => {
    const { deps, sessions } = fakeDeps();
    const reg = registerDevServer({ appId: "fresh", command: "x", port: 5192, cwd: "/tmp/x" }, deps);
    const id = reg.ok ? reg.sessionId : "";

    const stopped = stopIdleDevServers(60_000, Date.now(), deps);    // used <60s ago
    expect(stopped).not.toContain("fresh");
    expect(sessions.get(id)).toBe(true);                   // still alive
  });

  it("stopAllDevServers kills every running backend (LAX-shutdown path)", () => {
    const { deps, sessions } = fakeDeps();
    const a = registerDevServer({ appId: "a", command: "x", port: 5193, cwd: "/tmp/x" }, deps);
    const b = registerDevServer({ appId: "b", command: "x", port: 5194, cwd: "/tmp/x" }, deps);
    stopAllDevServers(deps);
    expect(sessions.get(a.ok ? a.sessionId : "")).toBe(false);
    expect(sessions.get(b.ok ? b.sessionId : "")).toBe(false);
    expect(devServerActivity().size).toBe(0);
  });
});

describe("appServeBackendTool", () => {
  it("validates inputs (numeric port required)", async () => {
    const r = await appServeBackendTool.execute({ app_id: "notes", command: "node s.js", port: "not-a-number" });
    expect(r.isError).toBe(true);
  });

  // Real spawn: an immediately-exiting command must be reported as a FAILURE
  // (not a dead "running" backend) and not left registered for auto-retry.
  // Regression for the notes build where `cd server` (from inside server/)
  // crashed instantly, npm install never ran, and the app shipped backend-less.
  it("reports a crashing command instead of a dead 'running' backend", async () => {
    const r = await appServeBackendTool.execute({ app_id: "crashy", command: "exit 7", port: 39517, cwd: tmpLax });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/exited/i);
    expect(existsSync(connectorFile("dev-crashy"))).toBe(false);   // forgot the bad registration
  }, 10_000);

  it("devConnectorName is always dev-<appId>", () => {
    expect(devConnectorName("my-app")).toBe("dev-my-app");
  });
});
