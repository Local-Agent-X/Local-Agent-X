// Bidirectional audio WebSocket — the transport layer for streaming voice.
//
// Protocol:
//   Path: /ws/voice
//   Auth: same token as /ws/chat (query param or sec-websocket-protocol)
//   Control messages (JSON, one line): { type: "hello", sessionId }
//                                       { type: "mute" | "unmute" }
//                                       { type: "eos" }  (end of speech, client-side)
//                                       { type: "bye" }
//   Audio frames (binary): Int16 PCM, 16kHz mono, ~30ms per frame (480 samples, 960 bytes)
//
// Phase 1 behavior: loopback. Any audio frame the client sends comes straight
// back out on the same socket so we can verify the transport end-to-end
// without touching STT, LLM, or TTS. Talk into the mic → hear your own
// voice back with ~20-50ms round-trip.
//
// Later phases will attach STT/LLM/TTS consumers to the frame stream via
// setVoiceSessionFactory() below.

import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage, Server } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { createLogger } from "../logger.js";
const logger = createLogger("voice.audio-ws");

export interface VoiceSession {
  /** Feed a 16kHz Int16 PCM frame from the client's mic */
  onMicFrame(frame: Int16Array): void;
  /** Called when the client explicitly signals end-of-speech */
  onEndOfSpeech?(): void;
  /** Called when the client updates voice settings (live, no restart) */
  onVoiceSettings?(settings: { voice?: string; speed?: number }): void;
  /** Called when the client disconnects or sends bye */
  close(): void;
}

export interface VoiceSessionContext {
  sessionId: string;
  sendAudio: (frame: Int16Array) => void;
  sendEvent: (event: Record<string, unknown>) => void;
}

type VoiceSessionFactory = (ctx: VoiceSessionContext) => VoiceSession;

// Default factory: loopback. Echoes mic frames back as audio frames.
// Replaced by the orchestrator in Phase 3 once STT/LLM/TTS are wired up.
let sessionFactory: VoiceSessionFactory = (ctx) => ({
  onMicFrame(frame) { ctx.sendAudio(frame); },
  close() {},
});

/** Register the real voice-session factory. Called from server.ts once the
 *  voice orchestrator is initialized (Phase 3). */
export function setVoiceSessionFactory(factory: VoiceSessionFactory): void {
  sessionFactory = factory;
}

export function setupVoiceWebSocket(server: Server, authToken: string): void {
  // Use noServer so we can route by path manually. When multiple
  // WebSocketServers attach via {server, path}, each one's upgrade handler
  // aborts requests whose path doesn't match ITS configured path with a
  // 400 response — not "leave the socket for the other WSS." So two
  // path-attached WSS on one server fight each other and the second one
  // never sees its requests. Standard ws-library workaround: noServer +
  // manual upgrade routing by path.
  const wss = new WebSocketServer({ noServer: true });
  const authBuf = Buffer.from(authToken);

  server.on("upgrade", (req, socket, head) => {
    try {
      const u = new URL(req.url || "/", "http://localhost");
      if (u.pathname !== "/ws/voice") return; // not our path — leave socket alone
      const hasToken = u.searchParams.get("token") ? "yes" : "no";
      logger.info(`[voice-ws] upgrade hit: url=${req.url} hasToken=${hasToken}`);
      wss.handleUpgrade(req, socket as import("node:net").Socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } catch (e) {
      logger.warn(`[voice-ws] upgrade error: ${(e as Error).message}`);
      try { socket.destroy(); } catch {}
    }
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // Auth: query param or subprotocol "lax-auth,<token>" (legacy "sax-auth"
    // also accepted for cached browser sessions across the rebrand).
    const url = new URL(req.url || "/", "http://localhost");
    let token = url.searchParams.get("token") || "";
    if (!token) {
      const protocols = req.headers["sec-websocket-protocol"] || "";
      const parts = protocols.split(",").map(s => s.trim());
      let idx = parts.indexOf("lax-auth");
      if (idx < 0) idx = parts.indexOf("sax-auth");
      if (idx >= 0 && parts[idx + 1]) token = parts[idx + 1];
    }
    const tokenBuf = Buffer.from(token);
    if (tokenBuf.length !== authBuf.length || !timingSafeEqual(tokenBuf, authBuf)) {
      const remote = req.socket.remoteAddress || "unknown";
      logger.warn(`[voice-ws] auth rejected from ${remote} — tokenLen=${tokenBuf.length} expected=${authBuf.length} match=${tokenBuf.length === authBuf.length ? "false" : "length-mismatch"}`);
      ws.close(4001, "Unauthorized");
      return;
    }
    logger.info(`[voice-ws] connection accepted from ${req.socket.remoteAddress}`);

    let sessionId = "";
    let session: VoiceSession | null = null;
    let closed = false;

    const ctx: VoiceSessionContext = {
      get sessionId() { return sessionId; },
      sendAudio(frame: Int16Array) {
        if (closed || ws.readyState !== ws.OPEN) return;
        // Send as binary. ws will transmit the raw bytes.
        ws.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), { binary: true });
      },
      sendEvent(event) {
        if (closed || ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify(event));
      },
    };

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (closed) return;

      if (isBinary) {
        // PCM frame from mic
        if (!session) return; // client sent audio before hello
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        // Int16Array view over the same buffer (no copy)
        const frame = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
        session.onMicFrame(frame);
        return;
      }

      // JSON control message
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "hello") {
          sessionId = String(msg.sessionId || "");
          if (!sessionId) { ws.close(4000, "hello requires sessionId"); return; }
          session = sessionFactory({
            sessionId,
            sendAudio: ctx.sendAudio,
            sendEvent: ctx.sendEvent,
          });
          ctx.sendEvent({ type: "ready", sessionId });
          logger.info(`[voice-ws] session opened: ${sessionId}`);
        } else if (msg.type === "eos") {
          session?.onEndOfSpeech?.();
        } else if (msg.type === "voice_settings") {
          session?.onVoiceSettings?.({
            voice: typeof msg.voice === "string" ? msg.voice : undefined,
            speed: typeof msg.speed === "number" ? msg.speed : undefined,
          });
        } else if (msg.type === "bye") {
          ws.close(1000, "bye");
        }
      } catch (e) {
        logger.warn(`[voice-ws] bad control message: ${(e as Error).message}`);
      }
    });

    ws.on("close", () => {
      closed = true;
      try { session?.close(); } catch {}
      logger.info(`[voice-ws] session closed: ${sessionId || "(no-hello)"}`);
    });

    ws.on("error", (err) => {
      logger.warn(`[voice-ws] socket error: ${err.message}`);
    });
  });

  logger.info(`[voice-ws] Listening on /ws/voice (auth-gated)`);
}
