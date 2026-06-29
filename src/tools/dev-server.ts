/**
 * Dev-server lifecycle — harness-owned Tier-1.5 backend management.
 *
 * A full-stack app (classified by app-tier.ts) needs a REAL backend running on
 * this machine; the served HTML frontend reaches it through a connector
 * (/api/connectors/dev-<appId>), which works over loopback on the desktop AND
 * over the broker from the phone (where a direct localhost fetch would hit the
 * phone, not this PC). Chunk 1 told the builder to do this by hand with
 * process_start + connector_create; this module makes it turnkey and reliable:
 *
 *   - registerDevServer / app_serve_backend — one call: wire the connector,
 *     start the process, persist a record. Idempotent (re-registering restarts).
 *   - ensureDevServerRunning — LAZY start-on-access. The served /apps/<id>/
 *     route calls this, so a registered backend runs ONLY while its app is
 *     actually open. Idle apps cost nothing — that's the resource-safety answer
 *     to "running many apps would melt the machine," and it survives a server
 *     restart (the in-memory process table is gone, so the next open restarts).
 *   - stopDevServer — kill the process; on app delete also forget the record +
 *     connector.
 *
 * Canonical reuse (no forks): processes go through process-session.ts (the one
 * long-lived-process manager); connector files go through connector-proxy.ts's
 * saveConnectorManifest/deleteConnectorManifest (the one manifest writer).
 * Records live under ~/.lax/dev-servers/<appId>.json — server-side only, never
 * under workspace/apps/<id>/ where the static route would serve them to apps.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { workspacePath } from "../config.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { SESSIONS, startSession, killSession, sleep, tailLines, pidsOnPort } from "./process-session.js";
import {
  saveConnectorManifest,
  deleteConnectorManifest,
  type ConnectorManifest,
} from "../routes/connector-proxy.js";
import {
  noteDevServerAccess,
  forgetDevServerAccess,
  devServerActivity,
  clearDevServerActivity,
  setDevServerWake,
} from "./dev-server-access.js";

/**
 * What the dev server IS, which decides how it's surfaced:
 *   - "backend"  — a real API server; the frontend reaches it through the
 *     /api/connectors/dev-<appId> proxy (works over loopback AND the broker).
 *   - "frontend" — a build-step dev server (Vite/Next/SPA); LAX reverse-proxies
 *     /apps/<appId>/ straight to it so the app URL serves the live dev server
 *     with HMR (desktop). No connector — it's not an API.
 */
export type DevServerKind = "backend" | "frontend";

export interface DevServerRecord {
  appId: string;
  command: string;
  cwd: string;
  port: number;
  /** Connector slug the frontend calls (always `dev-<appId>`). Backend only. */
  connector: string;
  /** Last process-session id. Ephemeral — null/stale after a server restart,
   *  which is fine: ensureDevServerRunning restarts on the next app open. */
  sessionId?: string;
  /** Defaults to "backend" for records written before the frontend kind. */
  kind?: DevServerKind;
}

/** Test seam: swap process control so unit tests never spawn a real server. */
export interface DevServerDeps {
  start?: (command: string, cwd?: string) => { session: { sessionId: string } } | { error: string };
  isAlive?: (sessionId: string) => boolean;
  kill?: (sessionId: string) => void;
}

function deps(d: DevServerDeps): Required<DevServerDeps> {
  return {
    start: d.start ?? ((command, cwd) => startSession(command, cwd)),
    isAlive: d.isAlive ?? ((sid) => { const s = SESSIONS.get(sid); return !!s && !s.exitedAt; }),
    kill: d.kill ?? ((sid) => { const s = SESSIONS.get(sid); if (s) killSession(s); }),
  };
}

/** How long to wait for a freshly-started backend to actually bind its port
 *  (or crash) before reporting. Covers a pure-JS `npm install` (express) + boot;
 *  a backend that needs longer than this almost always has a failing native
 *  install, which is exactly what we want to surface. */
const BACKEND_READY_TIMEOUT_MS = 20_000;
// A frontend dev server's cold `npm install` pulls a much heavier tree (vite +
// react + plugins = hundreds of packages), so give it longer to bind before we
// call it failed. A too-short window falsely reports "didn't start" even though
// the dev server comes up moments later — which pushes the model toward a
// needless production build to "verify" (the exact GPT-5.5 failure path).
const FRONTEND_READY_TIMEOUT_MS = 60_000;
const BACKEND_POLL_MS = 400;

/** Idle auto-stop: a backend untouched for this long is killed (its record is
 *  kept, so opening the app — or any connector request — wakes it again). */
export const DEV_SERVER_IDLE_MS = 15 * 60_000;
/** How often the sweeper checks for idle backends. */
const DEV_SERVER_SWEEP_MS = 2 * 60_000;

export function devConnectorName(appId: string): string {
  return `dev-${appId}`;
}

function recordsDir(): string {
  return join(getLaxDir(), "dev-servers");
}

function recordPath(appId: string): string {
  return join(recordsDir(), `${appId}.json`);
}

export function readDevServerRecord(appId: string): DevServerRecord | null {
  try {
    const o = JSON.parse(readFileSync(recordPath(appId), "utf8")) as Partial<DevServerRecord>;
    if (o && typeof o.command === "string" && typeof o.port === "number") {
      return { appId, command: o.command, cwd: o.cwd ?? "", port: o.port, connector: o.connector ?? devConnectorName(appId), sessionId: o.sessionId, kind: o.kind === "frontend" ? "frontend" : "backend" };
    }
  } catch { /* no record */ }
  return null;
}

function writeRecord(rec: DevServerRecord): void {
  mkdirSync(recordsDir(), { recursive: true });
  writeFileSync(recordPath(rec.appId), JSON.stringify(rec, null, 2) + "\n");
}

/** The dev connector points at the app's own localhost backend; the allow-list
 *  is broad on purpose — it's the user's own API, gated only to that one port. */
function devConnectorManifest(port: number): ConnectorManifest {
  return {
    upstream: `http://localhost:${port}`,
    auth: { type: "none" },
    allow: ["GET /*", "POST /*", "PUT /*", "PATCH /*", "DELETE /*"],
  };
}

export type RegisterResult =
  | { ok: true; connector: string; sessionId: string; port: number; cwd: string; restarted: boolean; kind: DevServerKind }
  | { ok: false; error: string };

/**
 * Wire the connector (backend only), (re)start the dev server, and persist the
 * record. Re-running for an already-running app restarts it (the command may
 * have changed). `kind` defaults to "backend"; "frontend" registers a build-step
 * dev server that the /apps/<id>/ route reverse-proxies (no connector).
 */
export function registerDevServer(
  input: { appId: string; command: string; port: number; cwd?: string; kind?: DevServerKind },
  d: DevServerDeps = {},
): RegisterResult {
  const { appId, command, port } = input;
  if (!appId || !command || !Number.isFinite(port) || port <= 0) {
    return { ok: false, error: "appId, command, and a positive numeric port are required" };
  }
  const kind: DevServerKind = input.kind === "frontend" ? "frontend" : "backend";
  const dd = deps(d);
  // Default cwd is the APP ROOT (not /server) so the command can `cd server`
  // into a backend subfolder OR run a root-level backend directly — both work.
  // A /server default broke the common `cd server && npm install && npm run dev`
  // (cd server from inside server/ fails → install never runs → dead backend).
  const cwd = input.cwd ?? workspacePath("apps", appId);
  const connector = devConnectorName(appId);

  // Restart cleanly if an earlier session for this app is still alive.
  const existing = readDevServerRecord(appId);
  const restarted = !!(existing?.sessionId && dd.isAlive(existing.sessionId));
  if (restarted && existing?.sessionId) dd.kill(existing.sessionId);

  // A backend is reached through its connector proxy; a frontend is reverse-
  // proxied transparently at /apps/<id>/, so it needs no connector manifest.
  if (kind === "backend") saveConnectorManifest(connector, devConnectorManifest(port));

  const started = dd.start(command, cwd);
  if ("error" in started) return { ok: false, error: started.error };

  const sessionId = started.session.sessionId;
  writeRecord({ appId, command, cwd, port, connector, sessionId, kind });
  noteDevServerAccess(appId);
  return { ok: true, connector, sessionId, port, cwd, restarted, kind };
}

export type EnsureResult =
  | { status: "running" | "started"; record: DevServerRecord }
  | { status: "none" }
  | { status: "error"; error: string };

/**
 * Lazy keep-alive: if the app has a registered backend that isn't currently
 * running, start it. Cheap no-op when already alive (a Map lookup), so it's
 * safe to call on every app open. Returns "none" for apps with no backend.
 */
export function ensureDevServerRunning(appId: string, d: DevServerDeps = {}): EnsureResult {
  const rec = readDevServerRecord(appId);
  if (!rec) return { status: "none" };
  const dd = deps(d);
  noteDevServerAccess(appId);
  if (rec.sessionId && dd.isAlive(rec.sessionId)) return { status: "running", record: rec };

  const started = dd.start(rec.command, rec.cwd || undefined);
  if ("error" in started) return { status: "error", error: started.error };
  const updated: DevServerRecord = { ...rec, sessionId: started.session.sessionId };
  writeRecord(updated);
  return { status: "started", record: updated };
}

/**
 * Stop an app's backend. `forget` (used on app delete) also removes the
 * connector and the record so nothing dangles. A plain stop keeps the record so
 * the next app open can lazily restart it.
 */
export function stopDevServer(appId: string, d: DevServerDeps = {}, opts: { forget?: boolean } = {}): void {
  const rec = readDevServerRecord(appId);
  const dd = deps(d);
  if (rec?.sessionId && dd.isAlive(rec.sessionId)) dd.kill(rec.sessionId);
  if (opts.forget) {
    forgetDevServerAccess(appId);
    deleteConnectorManifest(rec?.connector ?? devConnectorName(appId));
    if (existsSync(recordPath(appId))) { try { rmSync(recordPath(appId), { force: true }); } catch { /* gone */ } }
  }
}

/**
 * Stop backends untouched for longer than `idleMs`. The record is KEPT (opening
 * the app or any connector request restarts it), only the live process is
 * killed. Returns the appIds stopped. Called by the sweeper; pure in its inputs
 * (now + idleMs) so it's unit-testable without timers.
 */
export function stopIdleDevServers(idleMs: number, now: number, d: DevServerDeps = {}): string[] {
  const stopped: string[] = [];
  for (const [appId, ts] of [...devServerActivity()]) {
    if (now - ts <= idleMs) continue;
    stopDevServer(appId, d);          // kill process, keep record for a later wake
    forgetDevServerAccess(appId);     // drop from the active set until reopened
    stopped.push(appId);
  }
  return stopped;
}

/**
 * Kill every running backend (records kept). Wired into LAX shutdown so dev
 * servers don't orphan past the app's own lifetime — without this, the detached
 * child processes survive LAX exit and would hold their ports on restart.
 */
export function stopAllDevServers(d: DevServerDeps = {}): void {
  for (const [appId] of [...devServerActivity()]) stopDevServer(appId, d);
  clearDevServerActivity();
}

let sweeperStarted = false;
/** Start the idle-stop sweeper (once). Called at server boot; the interval is
 *  unref'd so it never holds the process open. */
export function startDevServerSweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;
  const t = setInterval(() => {
    try { stopIdleDevServers(DEV_SERVER_IDLE_MS, Date.now()); } catch { /* best-effort */ }
  }, DEV_SERVER_SWEEP_MS);
  t.unref();
}

// Connector traffic for dev-<appId> wakes a backend idle-stop took down while
// its app was still open — see dev-server-access.ts.
setDevServerWake((appId) => { ensureDevServerRunning(appId); });

type BackendOutcome =
  | { status: "listening" }
  | { status: "crashed"; code: number | null; output: string }
  | { status: "timeout" };

/** Poll until the backend binds its port, the process exits, or we time out —
 *  so app_serve_backend never reports a dead/never-bound backend as running. */
async function waitForBackend(sessionId: string, port: number, timeoutMs: number): Promise<BackendOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(BACKEND_POLL_MS);
    const s = SESSIONS.get(sessionId);
    if (s && s.exitedAt) {
      return { status: "crashed", code: s.exitCode, output: tailLines(s.stderr || s.stdout || "", 20).trim() };
    }
    if (pidsOnPort(port).length > 0) return { status: "listening" };
  }
  return { status: "timeout" };
}

export const appServeBackendTool: ToolDefinition = {
  name: "app_serve_backend",
  description:
    "Start and keep alive a full-stack app's REAL backend dev server, and wire a connector so the app's frontend can reach it (same-origin — works from the phone too). Use this for full-stack apps INSTEAD of process_start + connector_create: it registers the backend so LAX lazily restarts it when the app is opened and stops it when the app is deleted. The frontend then fetches /api/connectors/dev-<app_id>/<path> with Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__.",
  parameters: {
    type: "object",
    properties: {
      app_id: { type: "string", description: "The app's directory name (workspace/apps/<app_id>)." },
      command: { type: "string", description: "Command that starts the backend, e.g. 'npm install && npm run dev' or 'node server.js'." },
      port: { type: "number", description: "The localhost port the backend listens on." },
      cwd: { type: "string", description: "Working directory for the command. Defaults to workspace/apps/<app_id>/server." },
    },
    required: ["app_id", "command", "port"],
  },
  async execute(args): Promise<ToolResult> {
    const appId = String(args.app_id || "").replace(/[^a-zA-Z0-9_-]/g, "-");
    const command = String(args.command || "");
    const port = Number(args.port);
    const cwd = args.cwd ? String(args.cwd) : undefined;
    const res = registerDevServer({ appId, command, port, cwd });
    if (!res.ok) return { content: `Could not start backend: ${res.error}`, isError: true };

    // Don't claim success until the backend actually binds its port (or fails).
    // This is what catches the real failures: a native module (e.g.
    // better-sqlite3) that won't `npm install` against this Node, a wrong cwd, a
    // missing script, an ESM error — all of which otherwise ship a dead backend.
    const outcome = await waitForBackend(res.sessionId, port, BACKEND_READY_TIMEOUT_MS);
    if (outcome.status === "crashed") {
      stopDevServer(appId, {}, { forget: true });   // definitively dead — don't auto-retry it
      return {
        content:
          `Backend for "${appId}" exited (code ${outcome.code}) — the command failed, so the app has no working backend.\n` +
          `Command: ${command} (runs from the app root ${res.cwd}).\n` +
          `Common cause: a native dependency pinned to an OLD version that can't compile against this Node — use Node's built-in node:sqlite (no install), or depend on "better-sqlite3": "latest" (recent versions ship a prebuilt binary; an old "^9.x" pin does not). Fix it and call app_serve_backend again.\n` +
          (outcome.output ? `Output:\n${outcome.output}` : "(no output captured)"),
        isError: true,
      };
    }
    if (outcome.status === "timeout") {
      const s = SESSIONS.get(res.sessionId);
      const out = s ? tailLines(s.stderr || s.stdout || "", 20).trim() : "";
      return {
        content:
          `Backend for "${appId}" did NOT start listening on port ${port} within ${BACKEND_READY_TIMEOUT_MS / 1000}s — do not treat it as ready.\n` +
          `Likely a slow or failing install (an OLD native module like better-sqlite3 compiling from source), or it binds a different port. Check process_status(session_id="${res.sessionId}"); prefer node:sqlite (no build), or "better-sqlite3": "latest" (prebuilt).\n` +
          (out ? `Output:\n${out}` : ""),
        isError: true,
      };
    }
    return {
      content:
        `Backend for "${appId}" is up and listening on port ${port} (session ${res.sessionId}).\n` +
        `Connector "${res.connector}" wired — the frontend should fetch /api/connectors/${res.connector}/<path> ` +
        `with header Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__.\n` +
        `LAX will restart this backend when the app is opened and stop it when the app is deleted.`,
    };
  },
};

export const appServeFrontendTool: ToolDefinition = {
  name: "app_serve_frontend",
  description:
    "Start and keep alive a build-step FRONTEND dev server (Vite / Next / a React/Vue/Svelte SPA with HMR) for an app. LAX reverse-proxies /apps/<app_id>/ straight to it, so the app's own URL serves the live dev server. Use this INSTEAD of writing a single static index.html when the frontend genuinely needs its own dev server / build step. REQUIRED dev-server config: set base path to '/apps/<app_id>/' and HMR client port to the dev port (so hot-reload connects from the browser on desktop), and bind the given port. Hot-reload is desktop-only for now; the phone shows the result on reload.",
  parameters: {
    type: "object",
    properties: {
      app_id: { type: "string", description: "The app's directory name (workspace/apps/<app_id>)." },
      command: { type: "string", description: "Command that starts the dev server, e.g. 'npm install && npm run dev'." },
      port: { type: "number", description: "The localhost port the dev server listens on (also the HMR client port)." },
      cwd: { type: "string", description: "Working directory. Defaults to workspace/apps/<app_id>." },
    },
    required: ["app_id", "command", "port"],
  },
  async execute(args): Promise<ToolResult> {
    const appId = String(args.app_id || "").replace(/[^a-zA-Z0-9_-]/g, "-");
    const command = String(args.command || "");
    const port = Number(args.port);
    const cwd = args.cwd ? String(args.cwd) : undefined;
    const res = registerDevServer({ appId, command, port, cwd, kind: "frontend" });
    if (!res.ok) return { content: `Could not start frontend dev server: ${res.error}`, isError: true };

    const outcome = await waitForBackend(res.sessionId, port, FRONTEND_READY_TIMEOUT_MS);
    if (outcome.status === "crashed") {
      stopDevServer(appId, {}, { forget: true });
      return {
        content:
          `Frontend dev server for "${appId}" exited (code ${outcome.code}) — the command failed, so /apps/${appId}/ has nothing to proxy.\n` +
          `Command: ${command} (runs from ${res.cwd}). Fix it and call app_serve_frontend again.\n` +
          (outcome.output ? `Output:\n${outcome.output}` : "(no output captured)"),
        isError: true,
      };
    }
    if (outcome.status === "timeout") {
      const s = SESSIONS.get(res.sessionId);
      const out = s ? tailLines(s.stderr || s.stdout || "", 20).trim() : "";
      return {
        content:
          `Frontend dev server for "${appId}" did NOT start listening on port ${port} within ${FRONTEND_READY_TIMEOUT_MS / 1000}s — do not treat it as ready.\n` +
          `Likely a slow/failing install or a different port. Check process_status(session_id="${res.sessionId}").\n` +
          (out ? `Output:\n${out}` : ""),
        isError: true,
      };
    }
    return {
      content:
        `Frontend dev server for "${appId}" is up on port ${port} (session ${res.sessionId}). ` +
        `/apps/${appId}/ now reverse-proxies to it — open the app to see the live dev server.\n` +
        `Confirm the dev server's base is '/apps/${appId}/' and its HMR client port is ${port}, or assets/hot-reload will 404.\n` +
        `LAX restarts it when the app is opened and stops it when the app is deleted.`,
    };
  },
};
