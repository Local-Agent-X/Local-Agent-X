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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { workspacePath } from "../config.js";
import { SESSIONS, startSession, killSession, pidsOnPort } from "./process-session.js";
import { stripRedundantInstall } from "./dev-server-command.js";
import { withNodeTitleGuard } from "./env-contamination.js";
import { reclaimPort, verifyDevServerStartup } from "./dev-server-readiness.js";
import { killProcessGroupSync } from "../process-tree-kill.js";
import { createLogger } from "../logger.js";

// Startup-failure capture moved to dev-server-readiness.ts (its natural home,
// and this file sits at the LOC cap); re-exported for existing importers.
export { formatStartupFailure, persistDevServerStartupFailure } from "./dev-server-readiness.js";

const logger = createLogger("tools.dev-server");
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

/** Env a dev-server child needs. A frontend gets LAX_DEV_PORT so the harness-owned
 *  vite.config points HMR at the actual dev port (the /apps proxy can't carry the
 *  HMR websocket, so the browser connects ws://localhost:<port> directly). BOTH
 *  kinds get the macOS process.title crash guard (withNodeTitleGuard): a node dev
 *  server spawned under the desktop's app-bundle responsibility context SIGSEGVs
 *  the instant it sets process.title — the "code null / no output" death this
 *  module fought for days. Returns undefined only when there's nothing to add. */
function frontendEnv(kind: DevServerKind, port: number): Record<string, string> | undefined {
  const base: Record<string, string> = kind === "frontend" ? { LAX_DEV_PORT: String(port) } : {};
  const env = withNodeTitleGuard(base) as Record<string, string>;
  return Object.keys(env).length ? env : undefined;
}

/** Test seam: swap process control so unit tests never spawn a real server. */
export interface DevServerDeps {
  start?: (command: string, cwd?: string, env?: Record<string, string>) => { session: { sessionId: string } } | { error: string };
  isAlive?: (sessionId: string) => boolean;
  kill?: (sessionId: string) => void;
  /** Is something actually listening on the dev port? Verified alongside the
   *  session flag so a stale session (process gone) is healed by a restart. */
  portBound?: (port: number) => boolean;
  /** Fire-and-forget check that a lazily-restarted dev server actually bound its
   *  port; on a crash/never-bind it persists the child's captured output. The
   *  real impl polls live SESSIONS, so tests inject a no-op. */
  verifyStartup?: (appId: string, sessionId: string, port: number) => void;
  /** Epoch-ms the session started, or null if unknown. Used to tell a server
   *  that's still BOOTING (young, not yet bound) from one that's genuinely stuck,
   *  so the lazy-restart path doesn't kill a dev server mid-cold-start. */
  sessionStartedAt?: (sessionId: string) => number | null;
  /** Kill untracked processes holding the dev port (orphans from a previous LAX
   *  run) so a `--strictPort` respawn doesn't die against them. Returns killed
   *  pids. The real impl sync-kills via the OS, so tests inject a stub. */
  reclaimPort?: (port: number) => number[];
}

function deps(d: DevServerDeps): Required<DevServerDeps> {
  return {
    start: d.start ?? ((command, cwd, env) => startSession(command, cwd, env)),
    isAlive: d.isAlive ?? ((sid) => { const s = SESSIONS.get(sid); return !!s && !s.exitedAt; }),
    kill: d.kill ?? ((sid) => { const s = SESSIONS.get(sid); if (s) killSession(s); }),
    portBound: d.portBound ?? ((port) => pidsOnPort(port).length > 0),
    verifyStartup: d.verifyStartup ?? ((appId, sessionId, port) => { void verifyDevServerStartup(appId, sessionId, port); }),
    sessionStartedAt: d.sessionStartedAt ?? ((sid) => { const s = SESSIONS.get(sid); return s ? s.startedAt : null; }),
    reclaimPort: d.reclaimPort ?? reclaimPort,
  };
}

// How long a freshly-(re)started dev server is allowed to still be BINDING before
// the lazy-restart path treats it as stuck. A vite cold start is ~250ms, but a
// bigger app / first-run can take several seconds — and critically the cold-start
// holding page polls /apps/<id>/ every 1.5s, each poll re-entering
// ensureDevServerRunning: without this grace, every poll SIGKILLs the still-booting
// server (alive but not yet bound), so it NEVER binds — an infinite silent restart
// loop. Only a server that's been alive-yet-unbound PAST this window is genuinely
// stuck and gets restarted.
const DEV_SERVER_BIND_GRACE_MS = 30_000;

// The port-readiness check + the app_serve_* tools that use it live in
// dev-server-tools.ts (kept this file under the LOC cap).

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

/** Every persisted dev-server record. Lets a caller allocating a new dev port
 *  avoid the ports idle-but-registered servers will reclaim on their next
 *  lazy start — a live-port probe alone can't see those. */
export function listDevServerRecords(): DevServerRecord[] {
  let files: string[];
  try { files = readdirSync(recordsDir()); } catch { return []; }
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => readDevServerRecord(f.slice(0, -".json".length)))
    .filter((r): r is DevServerRecord => r !== null);
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

  // Free the port before spawning: the kill above is async (the old tree may
  // still be dying), and an orphan from a previous LAX run holds it invisibly —
  // either way a `--strictPort` child spawned now dies on arrival.
  const reclaimed = dd.reclaimPort(port);
  if (reclaimed.length > 0) {
    logger.warn(`[dev-server] ${appId}: killed ${reclaimed.length} untracked process(es) holding port ${port} (pids ${reclaimed.join(", ")}) before start`);
  }

  const started = dd.start(command, cwd, frontendEnv(kind, port));
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
  // "Running" requires BOTH the in-memory session flag AND the port actually
  // listening. A session can be stale — marked alive but its process gone (a
  // dev server killed externally, or one whose 'exit' didn't reach us) — which
  // otherwise wedges the app forever on a dead port: ensureDevServerRunning
  // returns "running", the proxy connects, ECONNREFUSED. Verifying the port
  // makes this self-healing.
  const alive = !!(rec.sessionId && dd.isAlive(rec.sessionId));
  if (alive && dd.portBound(rec.port)) return { status: "running", record: rec };
  if (alive) {
    // Alive but not yet listening. Distinguish STILL BOOTING from genuinely stuck:
    // a dev server spawned moments ago hasn't bound its port yet — that's a normal
    // cold start, not a dead session. Killing it here restarts the boot clock, and
    // because the cold-start holding page polls this route every 1.5s, each poll
    // would kill the next boot attempt → the server never binds (silent SIGKILL,
    // infinite restart). So within the bind grace, leave it alone and let the
    // proxy's cold-start retry wait for it; only past the grace is it truly stuck.
    const startedAt = dd.sessionStartedAt(rec.sessionId!);
    const booting = startedAt !== null && Date.now() - startedAt < DEV_SERVER_BIND_GRACE_MS;
    if (booting) return { status: "started", record: rec };
    logger.info(`[dev-server] ${appId}: session ${rec.sessionId} alive but port ${rec.port} dead past ${DEV_SERVER_BIND_GRACE_MS / 1000}s — restarting`);
    dd.kill(rec.sessionId!);
  }

  // Reclaim the port from holders this server doesn't track — the orphan class
  // (a dev server that outlived a previous LAX process). Without this, every
  // respawn dies instantly on `--strictPort` against the orphan while the port
  // probe reads "listening": one doomed spawn per request, forever — the
  // restart storm that broke HMR and flapped the app after a LAX restart.
  const reclaimed = dd.reclaimPort(rec.port);
  if (reclaimed.length > 0) {
    logger.warn(`[dev-server] ${appId}: killed ${reclaimed.length} untracked process(es) holding port ${rec.port} (pids ${reclaimed.join(", ")}) before restart`);
  }

  // Strip the redundant `npm install &&` before restarting: on this lazy-restart
  // hot path it's the wedge that leaves the app stuck on "Starting…" forever
  // (install segfaults under the sandbox, so the bind step never runs).
  const restartCmd = stripRedundantInstall(rec.command, rec.cwd || workspacePath("apps", appId));
  const started = dd.start(restartCmd, rec.cwd || undefined, frontendEnv(rec.kind ?? "backend", rec.port));
  if ("error" in started) { logger.warn(`[dev-server] ${appId}: restart failed: ${started.error}`); return { status: "error", error: started.error }; }
  const updated: DevServerRecord = { ...rec, sessionId: started.session.sessionId };
  writeRecord(updated);
  logger.info(`[dev-server] ${appId}: (re)started session ${started.session.sessionId} on port ${rec.port}`);
  // Unlike the agent-facing app_serve_* tools (which block on waitForBackend),
  // this lazy restart runs on the /apps request hot path, so it can't block. Fire
  // a non-blocking verify whose ONLY job is to capture — to server.log + a
  // per-app file — why a restart didn't bind, instead of the child's stderr being
  // lost to session eviction (the silent-502 bug). See dev-server-readiness.ts.
  dd.verifyStartup(appId, updated.sessionId!, rec.port);
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
  // Kill all dev servers when LAX exits. registerShutdown only handles SIGINT,
  // but the desktop quits the server with SIGTERM — whose handler (and SIGINT's)
  // both call process.exit, so the 'exit' event is the one signal-agnostic hook
  // that fires for a normal quit, a force-quit, and a parent-death shutdown.
  // The kill MUST be synchronous here: exit handlers run after the event loop
  // drains, so the default kill path's async taskkill never executed — on
  // Windows every dev server orphaned past a graceful quit and kept its port
  // (feeding the restart storm above). SIGKILL/crash still can't be trapped —
  // those orphans are reclaimed by reclaimPort on the next lazy start.
  process.on("exit", () => {
    try {
      stopAllDevServers({
        kill: (sid) => {
          const s = SESSIONS.get(sid);
          if (s && !s.exitedAt && s.pid) killProcessGroupSync(s.pid, s.child ?? undefined);
        },
      });
    } catch { /* exiting */ }
  });
}

// Connector traffic for dev-<appId> wakes a backend idle-stop took down while
// its app was still open — see dev-server-access.ts.
setDevServerWake((appId) => { ensureDevServerRunning(appId); });
