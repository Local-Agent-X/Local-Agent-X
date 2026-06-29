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
import { SESSIONS, startSession, killSession } from "./process-session.js";
import {
  saveConnectorManifest,
  deleteConnectorManifest,
  type ConnectorManifest,
} from "../routes/connector-proxy.js";

export interface DevServerRecord {
  appId: string;
  command: string;
  cwd: string;
  port: number;
  /** Connector slug the frontend calls (always `dev-<appId>`). */
  connector: string;
  /** Last process-session id. Ephemeral — null/stale after a server restart,
   *  which is fine: ensureDevServerRunning restarts on the next app open. */
  sessionId?: string;
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
      return { appId, command: o.command, cwd: o.cwd ?? "", port: o.port, connector: o.connector ?? devConnectorName(appId), sessionId: o.sessionId };
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
  | { ok: true; connector: string; sessionId: string; port: number; restarted: boolean }
  | { ok: false; error: string };

/**
 * Wire the connector, (re)start the backend, and persist the record. Re-running
 * for an already-running app restarts it (the command may have changed).
 */
export function registerDevServer(
  input: { appId: string; command: string; port: number; cwd?: string },
  d: DevServerDeps = {},
): RegisterResult {
  const { appId, command, port } = input;
  if (!appId || !command || !Number.isFinite(port) || port <= 0) {
    return { ok: false, error: "appId, command, and a positive numeric port are required" };
  }
  const dd = deps(d);
  const cwd = input.cwd ?? workspacePath("apps", appId, "server");
  const connector = devConnectorName(appId);

  // Restart cleanly if an earlier session for this app is still alive.
  const existing = readDevServerRecord(appId);
  const restarted = !!(existing?.sessionId && dd.isAlive(existing.sessionId));
  if (restarted && existing?.sessionId) dd.kill(existing.sessionId);

  saveConnectorManifest(connector, devConnectorManifest(port));

  const started = dd.start(command, cwd);
  if ("error" in started) return { ok: false, error: started.error };

  const sessionId = started.session.sessionId;
  writeRecord({ appId, command, cwd, port, connector, sessionId });
  return { ok: true, connector, sessionId, port, restarted };
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
    deleteConnectorManifest(rec?.connector ?? devConnectorName(appId));
    if (existsSync(recordPath(appId))) { try { rmSync(recordPath(appId), { force: true }); } catch { /* gone */ } }
  }
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
    return {
      content:
        `Backend for "${appId}" is running (session ${res.sessionId}, port ${port}).\n` +
        `Connector "${res.connector}" wired — the frontend should fetch /api/connectors/${res.connector}/<path> ` +
        `with header Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__.\n` +
        `LAX will restart this backend when the app is opened and stop it when the app is deleted.`,
    };
  },
};
