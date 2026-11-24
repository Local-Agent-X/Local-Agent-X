/**
 * One origin per app.
 *
 * Every app the agent builds is served by its own loopback listener, on its
 * own port, so each is its own browser origin: http://127.0.0.1:<port>. One
 * app's page cannot read another's HTML, the capabilities injected into it, or
 * its localStorage; the browser's same-origin policy is the boundary. The
 * listener answers for that one app and no other (agent-origin.ts decides what
 * a listener serves; this module owns which listeners exist).
 *
 *   - A listener is opened the first time its app is asked for, and only for
 *     an app that exists: the UI's redirect to an app is reachable without a
 *     token, so a page that names made-up apps must not open ports.
 *   - An app keeps its port across restarts (app-origin-ports.json in the data
 *     dir), and a port once given to an app is never given to another, deleted
 *     apps included. A browser profile keeps localStorage per port; a reused
 *     port would hand one app what another stored.
 *   - At most MAX_OPEN listeners stay open; the least recently used closes.
 *     Its port stays the app's, so it reopens where it was.
 */

import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createJsonStore, type JsonStore } from "../util/json-store.js";
import { addAppOriginPort, removeAppOriginPort } from "../security/layer/agent-origin-port.js";
import { createLogger } from "../logger.js";

const logger = createLogger("server.app-origins");

export const MAX_OPEN_APP_ORIGINS = 64;
const FRESH_PORT_ATTEMPTS = 8;
const APP_PATH_ID = /^\/(?:apps|dashboards)\/([a-zA-Z0-9_-]{1,64})(?:\/|$)/;

/** The app a /apps/<id>/… or /dashboards/<id>/… path belongs to, or null when
 *  the segment is not an app id. Every caller keys on this one reading. */
export function appIdOfPath(pathname: string): string | null {
  return pathname.match(APP_PATH_ID)?.[1] ?? null;
}

export interface AppOriginHost {
  /** The request listener for one app's listener; `port` answers once bound. */
  listenerFor(appId: string, port: () => number): RequestListener;
  /** Is there an app by this id to serve? */
  appExists(appId: string): boolean;
  /** Where ports are remembered; the data dir's file when not given. */
  portsFile?: string;
}

interface PortBook extends Record<string, unknown> {
  /** app id → the port that is that app's. */
  ports: Record<string, number>;
  /** Ports an app had and could not bind again. Never given out again. */
  retired: number[];
}

interface OpenOrigin { server: Server; port: number; lastUsed: number }

let host: AppOriginHost | null = null;
let book: JsonStore<PortBook> | null = null;
const open = new Map<string, OpenOrigin>();
const opening = new Map<string, Promise<string | null>>();
let clock = 0;

/** Called once the shared agent origin is bound; replaces any earlier host. */
export function initAppOrigins(next: AppOriginHost): void {
  host = next;
  book = createJsonStore<PortBook>(next.portsFile ?? (() => join(getLaxDir(), "app-origin-ports.json")), {
    defaults: () => ({ ports: {}, retired: [] }),
  });
}

function originOf(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function listen(server: Server, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const failed = () => resolve(null);
    server.once("error", failed);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", failed);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Bind the app's remembered port, or a port no app has ever had. */
async function bind(appId: string, listener: RequestListener, bound: { port: number }): Promise<Server | null> {
  const remembered = book!.load();
  const own = remembered.ports[appId];
  const taken = new Set<number>([...Object.values(remembered.ports), ...remembered.retired]);
  const candidates = own ? [own, ...Array<number>(FRESH_PORT_ATTEMPTS).fill(0)] : Array<number>(FRESH_PORT_ATTEMPTS).fill(0);
  for (const candidate of candidates) {
    const server = createServer(listener);
    const port = await listen(server, candidate);
    if (port === null) continue;
    if (port !== own && taken.has(port)) { await closeServer(server); continue; }
    bound.port = port;
    return server;
  }
  return null;
}

function remember(appId: string, port: number): void {
  book!.mutate((draft) => {
    const before = draft.ports[appId];
    if (before === port) return;
    // The app's old port could not be bound again; it stays out of circulation.
    if (before) draft.retired.push(before);
    draft.ports[appId] = port;
  });
}

async function evictBeyondCap(): Promise<void> {
  while (open.size > MAX_OPEN_APP_ORIGINS) {
    let oldest: string | null = null;
    for (const [appId, entry] of open) {
      if (oldest === null || entry.lastUsed < open.get(oldest)!.lastUsed) oldest = appId;
    }
    if (oldest === null) return;
    await closeAppOrigin(oldest);
  }
}

async function openOrigin(appId: string): Promise<string | null> {
  const bound = { port: 0 };
  const server = await bind(appId, host!.listenerFor(appId, () => bound.port), bound);
  if (!server) {
    logger.warn(`[app-origins] no port could be bound for app "${appId}"`);
    return null;
  }
  remember(appId, bound.port);
  open.set(appId, { server, port: bound.port, lastUsed: ++clock });
  addAppOriginPort(bound.port);
  await evictBeyondCap();
  return originOf(bound.port);
}

/**
 * The app's origin, opening its listener if need be. Null for a segment that
 * is not an app id, an app that does not exist, or before initAppOrigins.
 */
export function ensureAppOrigin(appId: string): Promise<string | null> {
  if (!host || appIdOfPath(`/apps/${appId}`) !== appId) return Promise.resolve(null);
  const live = open.get(appId);
  if (live) {
    live.lastUsed = ++clock;
    return Promise.resolve(originOf(live.port));
  }
  if (!host.appExists(appId)) return Promise.resolve(null);
  const pending = opening.get(appId);
  if (pending) return pending;
  const started = openOrigin(appId).finally(() => { opening.delete(appId); });
  opening.set(appId, started);
  return started;
}

/** The app's origin when its listener is open right now; never opens one. */
export function appOriginIfOpen(appId: string): string | null {
  const live = open.get(appId);
  return live ? originOf(live.port) : null;
}

/**
 * Close an app's listener. The port stays that app id's for good, a deleted
 * or renamed-away app's included: no other app is ever given it, and an app
 * made again under the same id opens where the old one was.
 */
export async function closeAppOrigin(appId: string): Promise<void> {
  await opening.get(appId);
  const live = open.get(appId);
  if (!live) return;
  open.delete(appId);
  removeAppOriginPort(live.port);
  await closeServer(live.server);
}

export async function closeAllAppOrigins(): Promise<void> {
  await Promise.all([...opening.values()]);
  await Promise.all([...open.keys()].map((appId) => closeAppOrigin(appId)));
}
