/**
 * A record, in the server log, of each chat socket: when it connected, which
 * chats it listened to, the last frame it was sent for each, and when and why
 * it closed. And for every turn, which sockets it reached as it started.
 *
 * Why: a turn the app started by itself (a background job ended and LAX woke
 * the chat) showed live on the phone and not at all on the desktop, open on
 * that chat, until the owner answered from the phone (Label Check Sol,
 * 2026-11-27). The desktop's own handling of such a turn was checked and is
 * right (test/chat-app-started-turn.test.ts), so the frames most likely never
 * reached it; nothing recorded whether its socket was connected and
 * listening at that moment. The next time, these lines say.
 *
 * Kinds: "browser" is a page (the desktop window, a browser tab: the upgrade
 * carried an Origin), "bridge" a loopback client (the phone's broker bridge).
 * One line per event, no frame contents.
 */
import type { WebSocket } from "ws";
import { createLogger } from "../logger.js";

const logger = createLogger("chat-ws.connections");

interface SocketRecord {
  id: number;
  kind: "browser" | "bridge";
  connectedAt: number;
  /** Per chat: the last frame sent to this socket, and when. */
  lastSent: Map<string, { type: string; at: number }>;
}

const records = new WeakMap<WebSocket, SocketRecord>();
let nextId = 1;

const clock = (at: number) => new Date(at).toISOString().slice(11, 19);
const ago = (at: number) => `${Math.round((Date.now() - at) / 1000)}s ago`;

export function noteConnected(ws: WebSocket, browser: boolean): void {
  const record: SocketRecord = { id: nextId++, kind: browser ? "browser" : "bridge", connectedAt: Date.now(), lastSent: new Map() };
  records.set(ws, record);
  logger.info(`[ws-conn] #${record.id} ${record.kind} connected`);
  ws.on("close", (code: number, reason: Buffer) => {
    const lived = Math.round((Date.now() - record.connectedAt) / 1000);
    const last = [...record.lastSent.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, 3)
      .map(([sid, s]) => `${sid}: ${s.type} at ${clock(s.at)}`).join("; ");
    logger.info(`[ws-conn] #${record.id} ${record.kind} closed code=${code}${reason?.length ? ` reason="${reason.toString().slice(0, 80)}"` : ""} after ${lived}s${last ? `; last sent ${last}` : ""}`);
  });
}

/** The heartbeat found the socket dead and cut it. */
export function noteNoPong(ws: WebSocket): void {
  const record = records.get(ws);
  if (record) logger.warn(`[ws-conn] #${record.id} ${record.kind} missed its heartbeat: terminated`);
}

export function noteSubscribed(ws: WebSocket, sessionId: string): void {
  const record = records.get(ws);
  if (record) logger.info(`[ws-conn] #${record.id} ${record.kind} listens to ${sessionId}`);
}

export function noteSent(ws: WebSocket, sessionId: string, type: string): void {
  const record = records.get(ws);
  if (record) record.lastSent.set(sessionId, { type, at: Date.now() });
}

/** The page's own side, sent on each connect (public/js/chat-ws-diag.js):
 *  why its last socket went away, how long it was down, and the last frame it
 *  received per chat. Read as data from the page, logged, never acted on. */
export function noteClientReport(ws: WebSocket, report: Record<string, unknown>): void {
  const record = records.get(ws);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v / 1000) : undefined);
  const word = (v: unknown) => String(v ?? "").replace(/[^\w .:=-]/g, "").slice(0, 120);
  const received = (Array.isArray(report.lastReceived) ? report.lastReceived : []).slice(0, 5)
    .map((r: any) => `${word(r?.sessionId)}: ${word(r?.type)} ${num(r?.agoMs) ?? "?"}s ago`).join("; ");
  const head = report.reconnect
    ? `reconnected after ${num(report.downMs) ?? "?"}s down (${word(report.dropReason)}; previous socket lived ${num(report.lastConnectedMs) ?? "?"}s)`
    : "first connect";
  logger.info(`[ws-conn] #${record?.id ?? "?"} page reports ${head}${received ? `; last received ${received}` : ""}`);
}

/** A turn is starting on `sessionId`: which sockets it reaches. */
export function noteTurnAudience(sessionId: string, clients: ReadonlyMap<WebSocket, Set<string>>): void {
  const reached: string[] = [];
  let browsersOpen = 0;
  for (const [ws, subs] of clients) {
    const record = records.get(ws);
    if (!record) continue;
    if (record.kind === "browser" && ws.readyState === 1) browsersOpen++;
    if (!subs.has(sessionId) || ws.readyState !== 1) continue;
    const last = record.lastSent.get(sessionId);
    reached.push(`#${record.id} ${record.kind}${last ? ` (last sent ${last.type} ${ago(last.at)})` : ""}`);
  }
  logger.info(`[ws-conn] turn on ${sessionId} reaches ${reached.length ? reached.join(", ") : "no socket"}` +
    `${browsersOpen > 0 && !reached.some((r) => r.includes("browser")) ? ` — ${browsersOpen} browser socket(s) open, none listening to this chat` : ""}`);
}
