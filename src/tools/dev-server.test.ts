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
  formatStartupFailure,
  persistDevServerStartupFailure,
  type DevServerDeps,
} from "./dev-server.js";
import { formatBoundThenDied } from "./dev-server-readiness.js";
import { appServeBackendTool } from "./dev-server-tools.js";
import { clearDevServerActivity, devServerActivity } from "./dev-server-access.js";

let tmpLax: string;
let prevDataDir: string | undefined;

// Fake process control so no real dev server is spawned. sessionId → alive.
// verifyStartup is stubbed to record its calls (the real one polls live SESSIONS
// and writes log files — neither wanted in a unit test).
function fakeDeps(): {
  deps: Required<DevServerDeps>;
  sessions: Map<string, boolean>;
  startTimes: Map<string, number>;
  starts: string[];
  verifyCalls: { appId: string; sessionId: string; port: number }[];
  reclaimCalls: number[];
} {
  const sessions = new Map<string, boolean>();
  const startTimes = new Map<string, number>();   // sessionId → epoch-ms start (backdate to simulate a stuck one)
  const starts: string[] = [];
  const verifyCalls: { appId: string; sessionId: string; port: number }[] = [];
  const reclaimCalls: number[] = [];
  let n = 0;
  const deps: Required<DevServerDeps> = {
    start: (command) => { const id = `s${++n}`; sessions.set(id, true); startTimes.set(id, Date.now()); starts.push(command); return { session: { sessionId: id } }; },
    isAlive: (sid) => sessions.get(sid) === true,
    kill: (sid) => { sessions.set(sid, false); },
    portBound: () => true,   // default: an alive session is also bound to its port
    verifyStartup: (appId, sessionId, port) => { verifyCalls.push({ appId, sessionId, port }); },
    sessionStartedAt: (sid) => startTimes.get(sid) ?? null,
    reclaimPort: (port) => { reclaimCalls.push(port); return []; },
  };
  return { deps, sessions, startTimes, starts, verifyCalls, reclaimCalls };
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

  it("self-heals a STALE session: alive flag set but the port is DEAD (past bind grace) → restart, not a wedge", () => {
    // The real-world bug: a dev server killed externally leaves its session flag
    // 'alive' in memory, so ensureDevServerRunning returned 'running' and the
    // proxy connected to a dead port forever (ECONNREFUSED). The port probe fixes it.
    const { deps, sessions, startTimes, starts } = fakeDeps();
    const reg = registerDevServer({ appId: "stale", command: "vite", port: 5210, cwd: "/tmp/x" }, deps);
    expect(reg.ok && sessions.get(reg.sessionId)).toBe(true);   // session reads alive
    if (reg.ok) startTimes.set(reg.sessionId, Date.now() - 60_000); // long-alive → genuinely stuck, not booting
    const portDead = { ...deps, portBound: () => false };       // ...but nothing on the port

    const res = ensureDevServerRunning("stale", portDead);
    expect(res.status).toBe("started");   // restarted, NOT a no-op 'running'
    expect(starts).toHaveLength(2);       // original register + the heal restart
  });

  it("does NOT kill a still-BOOTING dev server: alive + unbound but freshly started → wait, no restart", () => {
    // The wedge fix: a dev server spawned moments ago hasn't bound its port yet.
    // The cold-start holding page polls this route every 1.5s; without the bind
    // grace each poll would SIGKILL the booting server and it would NEVER bind
    // (silent infinite restart — the "stuck on Starting…" bug). Within the grace,
    // an alive-but-unbound (young) session is left to finish booting.
    const { deps, sessions, starts } = fakeDeps();
    const reg = registerDevServer({ appId: "booting", command: "vite", port: 5211, cwd: "/tmp/x" }, deps);
    const sid = reg.ok ? reg.sessionId : "";
    expect(sessions.get(sid)).toBe(true);
    const portDead = { ...deps, portBound: () => false };       // still coming up — not listening yet

    const res = ensureDevServerRunning("booting", portDead);
    expect(res.status).toBe("started");
    if (res.status === "started") expect(res.record.sessionId).toBe(sid);  // SAME session — not restarted
    expect(starts).toHaveLength(1);        // only the original register; NO kill+restart
    expect(sessions.get(sid)).toBe(true);  // the booting session was NOT killed
  });

  // Regression for the silent-502 bug: the idle-sweep kills a dev server, the
  // phone/desktop reopens the app → ensureDevServerRunning lazily restarts it, but
  // NOTHING verified the restart bound its port, so a child that died left the
  // proxy to spin 12s → ECONNREFUSED with the cause lost to session eviction.
  it("fires verifyStartup on a lazy restart (so a never-bound restart is captured)", () => {
    const { deps, sessions, verifyCalls } = fakeDeps();
    const reg = registerDevServer({ appId: "notes", command: "npm run dev", port: 5180, cwd: "/tmp/x" }, deps);
    const oldId = reg.ok ? reg.sessionId : "";
    sessions.set(oldId, false);                           // server restart wiped the process

    verifyCalls.length = 0;                               // ignore the register-time call
    const res = ensureDevServerRunning("notes", deps);
    expect(res.status).toBe("started");
    expect(verifyCalls).toHaveLength(1);
    expect(verifyCalls[0]).toMatchObject({ appId: "notes", port: 5180 });
    if (res.status === "started") expect(verifyCalls[0].sessionId).toBe(res.record.sessionId);
  });

  it("does NOT fire verifyStartup when the server is already healthy (no restart)", () => {
    const { deps, verifyCalls } = fakeDeps();
    registerDevServer({ appId: "notes", command: "npm run dev", port: 5180, cwd: "/tmp/x" }, deps);
    verifyCalls.length = 0;
    const res = ensureDevServerRunning("notes", deps);   // alive + port bound
    expect(res.status).toBe("running");
    expect(verifyCalls).toHaveLength(0);
  });
});

// The restart-storm regression: after a LAX restart the record's session is
// unknown to the new process, but the ORPHANED dev server still holds the port.
// Every request then spawned a replacement that died instantly on --strictPort
// while the port probe read "listening" — one doomed spawn per request, forever.
// The fix: reclaim (kill) untracked port holders BEFORE every respawn.
describe("port reclaim before spawn", () => {
  it("ensureDevServerRunning reclaims the port before a lazy restart", () => {
    const { deps, sessions, reclaimCalls } = fakeDeps();
    const reg = registerDevServer({ appId: "storm", command: "npx vite --strictPort", port: 5220, cwd: "/tmp/x" }, deps);
    const oldId = reg.ok ? reg.sessionId : "";
    sessions.set(oldId, false);       // LAX restarted: session unknown/dead...
    reclaimCalls.length = 0;          // ...but the orphan still holds 5220

    const res = ensureDevServerRunning("storm", deps);
    expect(res.status).toBe("started");
    expect(reclaimCalls).toEqual([5220]);                       // orphan killed first
    if (res.status === "started") expect(res.record.sessionId).not.toBe(oldId);
  });

  it("ensureDevServerRunning does NOT reclaim on the healthy fast path", () => {
    const { deps, reclaimCalls } = fakeDeps();
    registerDevServer({ appId: "healthy", command: "vite", port: 5221, cwd: "/tmp/x" }, deps);
    reclaimCalls.length = 0;
    expect(ensureDevServerRunning("healthy", deps).status).toBe("running");
    expect(reclaimCalls).toHaveLength(0);   // nothing killed under a live server
  });

  it("registerDevServer reclaims the port before starting (restart race + orphan)", () => {
    const { deps, reclaimCalls } = fakeDeps();
    registerDevServer({ appId: "reg", command: "vite", port: 5222, cwd: "/tmp/x" }, deps);
    expect(reclaimCalls).toEqual([5222]);
  });
});

describe("startup-failure capture (survives session eviction)", () => {
  it("formatStartupFailure surfaces the exit code + captured stderr tail", () => {
    const crashed = formatStartupFailure("notes", "s1", 5180, {
      status: "crashed", code: 127, signal: null, output: "sh: vite: command not found",
    });
    expect(crashed).toMatch(/exited \(code 127\)/);
    expect(crashed).toMatch(/vite: command not found/);

    // A signal death (the "code null" gremlin) names the signal, not "code null".
    const signalled = formatStartupFailure("notes", "s1", 5180, {
      status: "crashed", code: null, signal: "SIGKILL", output: "",
    });
    expect(signalled).toMatch(/killed by SIGKILL/);
    expect(signalled).not.toMatch(/code null/);

    const timedOut = formatStartupFailure("notes", "s1", 5180, { status: "timeout", output: "" });
    expect(timedOut).toMatch(/did NOT bind port 5180/);
    expect(timedOut).toMatch(/no output captured/);
  });

  it("formatBoundThenDied names the foreign port owner (the storm's false 'listening')", () => {
    // Port still bound after our child died = something we don't track owns it.
    const foreign = formatBoundThenDied("notes", "s1", 5220, {
      code: 1, signal: null, output: "Port 5220 is already in use", portStillBound: true,
    });
    expect(foreign).toMatch(/session then exited \(code 1\)/);
    expect(foreign).toMatch(/STILL bound/);
    expect(foreign).toMatch(/does not track/);
    expect(foreign).toMatch(/already in use/);

    const flap = formatBoundThenDied("notes", "s1", 5220, {
      code: null, signal: "SIGKILL", output: "", portStillBound: false,
    });
    expect(flap).toMatch(/killed by SIGKILL/);
    expect(flap).toMatch(/no longer bound/);
  });

  it("persistDevServerStartupFailure appends the diagnostic to a per-app log file", () => {
    persistDevServerStartupFailure("notes", "lazy restart FAILED: process exited (code 1)");
    const logFile = join(tmpLax, "logs", "dev-servers", "notes.log");
    expect(existsSync(logFile)).toBe(true);
    expect(readFileSync(logFile, "utf8")).toMatch(/process exited \(code 1\)/);

    // Appends (doesn't clobber) so repeated restart failures accumulate.
    persistDevServerStartupFailure("notes", "second failure");
    const body = readFileSync(logFile, "utf8");
    expect(body).toMatch(/process exited \(code 1\)/);
    expect(body).toMatch(/second failure/);
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

describe("registerDevServer kind — backend vs frontend", () => {
  it("backend (default) writes a connector manifest; the record is kind=backend", () => {
    const { deps } = fakeDeps();
    const r = registerDevServer({ appId: "api", command: "node s.js", port: 5200, cwd: "/tmp/x" }, deps);
    expect(r.ok && r.kind).toBe("backend");
    expect(existsSync(connectorFile("dev-api"))).toBe(true);
    expect(readDevServerRecord("api")?.kind).toBe("backend");
  });

  it("frontend writes NO connector manifest (it's reverse-proxied, not an API) and records kind=frontend", () => {
    const { deps } = fakeDeps();
    const r = registerDevServer({ appId: "spa", command: "npm run dev", port: 5201, cwd: "/tmp/x", kind: "frontend" }, deps);
    expect(r.ok && r.kind).toBe("frontend");
    expect(existsSync(connectorFile("dev-spa"))).toBe(false);   // frontend ≠ connector
    expect(readDevServerRecord("spa")?.kind).toBe("frontend");
  });

  it("a record written before the kind field reads back as backend (back-compat)", () => {
    const { deps } = fakeDeps();
    registerDevServer({ appId: "legacy", command: "x", port: 5202, cwd: "/tmp/x" }, deps);
    // readDevServerRecord defaults a missing kind to "backend".
    expect(readDevServerRecord("legacy")?.kind).toBe("backend");
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
