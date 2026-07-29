/**
 * The dev-server RECORD STORE — ~/.lax/dev-servers/<appId>.json — extracted from
 * dev-server.ts as a DEPENDENCY-FREE leaf (node:fs + the data dir, nothing else).
 *
 * Why a leaf: the security layer needs to know which loopback ports belong to
 * dev servers the agent started (security/layer/security-config.ts
 * devServerLoopbackPorts). Importing dev-server.ts from there would pull in
 * process-session.ts, which imports security/layer/index.js — an import cycle
 * through the very module making the decision. Same reason dev-server-access.ts
 * is a leaf. dev-server.ts re-exports everything here, so existing importers
 * are unchanged and there is still exactly ONE reader/writer of the store.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

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

export function devConnectorName(appId: string): string {
  return `dev-${appId}`;
}

function recordsDir(): string {
  return join(getLaxDir(), "dev-servers");
}

export function devServerRecordPath(appId: string): string {
  return join(recordsDir(), `${appId}.json`);
}

export function readDevServerRecord(appId: string): DevServerRecord | null {
  try {
    const o = JSON.parse(readFileSync(devServerRecordPath(appId), "utf8")) as Partial<DevServerRecord>;
    if (o && typeof o.command === "string" && typeof o.port === "number") {
      return { appId, command: o.command, cwd: o.cwd ?? "", port: o.port, connector: o.connector ?? devConnectorName(appId), sessionId: o.sessionId, kind: o.kind === "frontend" ? "frontend" : "backend" };
    }
  } catch { /* no record */ }
  return null;
}

export function writeDevServerRecord(rec: DevServerRecord): void {
  mkdirSync(recordsDir(), { recursive: true });
  writeFileSync(devServerRecordPath(rec.appId), JSON.stringify(rec, null, 2) + "\n");
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

/**
 * Ports of the dev servers THIS harness registered, as validated port strings.
 *
 * Folded into the security layer's localServicePorts (security-config.ts) so the
 * agent can fetch the page of an app it just served — the app-build verify loop.
 * The registration gap this closes was the real root cause of C4: app_serve_
 * frontend/backend started a server on e.g. 3011 and persisted a record, but
 * nothing ever told the egress gate about it, so both `127.0.0.1:3011` and the
 * `/apps/<id>/` redirect to `localhost:3011` were denied.
 *
 * SECURITY: ports only, never a host — the loopback-host gate in network-policy
 * still decides WHERE a port may be dialed, so an entry here can never widen
 * reach past loopback (identical invariant to localRuntimeLoopbackPorts). And it
 * grants no authority the agent lacks: registerDevServer SPAWNS the listener on
 * that port (killing any prior holder first), so the agent is reading a process
 * it owns, not eavesdropping on someone else's local service. Read fresh from
 * disk per decision — never a cached allowlist.
 */
export function devServerLoopbackPorts(): Set<string> {
  const ports = new Set<string>();
  for (const rec of listDevServerRecords()) {
    if (Number.isInteger(rec.port) && rec.port > 0 && rec.port <= 65535) ports.add(String(rec.port));
  }
  return ports;
}
