// WebSocket-upgrade authorization for the local operator.
//
// The desktop server accepts WS upgrades (/ws/chat, /ws/voice) from ONE
// principal: the local operator (the Electron UI and the broker phone both
// reach the desktop over loopback as the operator — the broker chat/voice
// bridges connect with the operator token). This is the single place that
// decides whether an upgrade is allowed: a timing-safe operator-token compare,
// nothing else. Rejections carry an actionable reason so the caller can close
// with a clear message instead of a silent hang.
//
// It is also the one way an endpoint takes its upgrades (serveOperatorSocket):
// the path routing, the cross-site Origin refusal and the token read were
// written out in chat-ws and again in voice-ws, with a third list of the paths
// in the upgrade reaper.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { isLoopbackOrigin } from "../server-utils.js";

/** WS close code for an unauthorized/rejected upgrade. */
export const WS_UNAUTHORIZED = 4401;

export interface UpgradeAuthResult {
  ok: boolean;
  /** Principal kind for an accepted connection. */
  principal?: "operator";
  /** Actionable reason on rejection (sent as the WS close message). */
  reason?: string;
}

function constTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Authorize a WS upgrade. Accepts ONLY the operator token (timing-safe compare).
 * Returns an actionable reason on rejection so the caller can close with a clear
 * message instead of a silent hang.
 */
export function authorizeUpgrade(token: string, operatorToken: string): UpgradeAuthResult {
  if (token && operatorToken && constTimeEq(token, operatorToken)) {
    return { ok: true, principal: "operator" };
  }
  return { ok: false, reason: "Unauthorized" };
}

/** The token an upgrade carries: `?token=`, or the pair `lax-auth, <token>` in
 *  Sec-WebSocket-Protocol (a browser cannot set headers on a WebSocket). */
export function upgradeToken(req: IncomingMessage): string {
  const url = new URL(req.url || "/", "http://localhost");
  const queryToken = url.searchParams.get("token") || "";
  if (queryToken) return queryToken;

  const protocols = req.headers["sec-websocket-protocol"] || "";
  const parts = protocols.split(",").map((s) => s.trim());
  const authIdx = parts.indexOf("lax-auth");
  return authIdx >= 0 && parts[authIdx + 1] ? parts[authIdx + 1] : "";
}

export interface OperatorSocketOptions {
  /** The upgrade path this endpoint owns ("/ws/chat"). */
  path: string;
  operatorToken: string;
  /** Caps one frame. Without it the ws default is 100 MiB, which would let
   *  through what the operator's HTTP body cap refuses. */
  maxPayloadBytes: number;
  /** The endpoint's own logger and the tag its lines carry ("voice-ws"). */
  logger: { info(message: string): void; warn(message: string): void };
  tag: string;
  /** Log every upgrade, refusal and accepted connection, not only errors. */
  logConnections?: boolean;
}

const claimedPaths = new WeakMap<Server, Set<string>>();

/** The upgrade paths an operator socket owns on `server`. The reaper
 *  (server/lifecycle.ts) destroys an upgrade for any other path. */
export function operatorSocketPaths(server: Server): ReadonlySet<string> {
  return claimedPaths.get(server) ?? new Set();
}

/**
 * Serve an operator-only WebSocket endpoint on `server`: `onConnection` is
 * called for a connection that came to `path`, was not opened by a cross-site
 * page, and carries the operator token. Anything else is closed here.
 *
 * noServer + manual upgrade routing, so several endpoints share one http
 * server: a WebSocketServer attached with {server, path} aborts every upgrade
 * whose path is not its own, and the second endpoint never sees its requests.
 */
export function serveOperatorSocket(
  server: Server,
  opts: OperatorSocketOptions,
  onConnection: (ws: WebSocket, req: IncomingMessage) => void,
): WebSocketServer {
  const { path, tag, logger } = opts;
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayloadBytes });
  claimedPaths.set(server, new Set([...operatorSocketPaths(server), path]));

  server.on("upgrade", (req, socket, head) => {
    try {
      const u = new URL(req.url || "/", "http://localhost");
      if (u.pathname !== path) return; // another endpoint's: leave the socket alone
      // Reject cross-origin handshakes (cross-site WebSocket hijacking): a
      // browser always sends Origin, so a non-loopback Origin is a cross-site
      // page dialing our socket. Non-browser clients (the broker bridges,
      // connecting to loopback as the operator) send no Origin and still face
      // the operator-token check below. Mirrors the HTTP CORS posture.
      const origin = req.headers.origin;
      if (origin && !isLoopbackOrigin(origin)) { try { socket.destroy(); } catch {} return; }
      // The path only: the query carries the operator token itself.
      if (opts.logConnections) logger.info(`[${tag}] upgrade hit: path=${u.pathname} hasToken=${u.searchParams.get("token") ? "yes" : "no"}`);
      wss.handleUpgrade(req, socket as Socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } catch (e) {
      logger.warn(`[${tag}] upgrade error: ${(e as Error).message}`);
      try { socket.destroy(); } catch {}
    }
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // The operator token only (loopback). A refusal carries a reason and a
    // clean close code; never a silent hang (constitution §7).
    const auth = authorizeUpgrade(upgradeToken(req), opts.operatorToken);
    const remote = req.socket.remoteAddress || "unknown";
    if (!auth.ok) {
      if (opts.logConnections) logger.warn(`[${tag}] auth rejected from ${remote} — ${auth.reason}`);
      ws.close(WS_UNAUTHORIZED, auth.reason || "Unauthorized");
      return;
    }
    if (opts.logConnections) logger.info(`[${tag}] connection accepted from ${remote} (${auth.principal})`);
    onConnection(ws, req);
  });
  return wss;
}
