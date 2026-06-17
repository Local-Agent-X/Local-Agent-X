// Bidirectional audio WebSocket — the transport layer for streaming voice.
//
// Protocol:
//   Path: /ws/voice
//   Auth: same token as /ws/chat (query param or sec-websocket-protocol)
//
// One socket carries audio over one of TWO transports, chosen by the client's
// opening `hello`:
//   (a) PCM (default; transport absent or "pcm") — audio rides this socket as
//       binary frames both ways: Int16 PCM, 16kHz mono, ~30ms per frame (480
//       samples, 960 bytes). Mic frames in, TTS frames out.
//   (b) WebRTC (hello.transport:"webrtc") — audio rides a werift VoicePeer
//       (mic in via Opus → 16kHz PCM → STT; TTS PCM → 48kHz Opus → paced RTP),
//       and this socket carries only SDP/ICE signaling plus the JSON control
//       events. Desktop is the OFFERER: on hello it sends `rtc_offer`, the
//       client replies `rtc_answer`, and both trickle `rtc_ice`. See the
//       "Optional WebRTC audio transport" section below.
//
// Control messages (JSON, one line) the handler accepts:
//   { type: "hello", sessionId, mode?, clientStt?, transport? }  open session
//   { type: "eos" }                              end of speech (client-side)
//   { type: "transcript", text, isFinal? }       client-side STT result
//   { type: "voice_settings", voice?, speed? }   live voice/speed change
//   { type: "rtc_answer", sdp }                  WebRTC only — SDP answer
//   { type: "rtc_ice", candidate }               WebRTC only — trickle ICE
//   { type: "bye" }                              close
//
// STT/LLM/TTS consumers attach to the frame stream via the factory registered
// with setVoiceSessionFactory() below.

import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage, Server } from "node:http";

import { createLogger } from "../logger.js";
import { isLoopbackOrigin } from "../server-utils.js";
import { authorizeUpgrade, trackDeviceSocket, WS_UNAUTHORIZED } from "../bridge/upgrade-auth.js";
import { isBridgeEnabled } from "../bridge/config.js";
import { isTailnetOrigin } from "../bridge/tailnet.js";
const logger = createLogger("voice.audio-ws");

export interface VoiceSession {
  /** Feed a 16kHz Int16 PCM frame from the client's mic */
  onMicFrame(frame: Int16Array): void;
  /** Called when the client explicitly signals end-of-speech */
  onEndOfSpeech?(): void;
  /** Called when the client updates voice settings (live, no restart) */
  onVoiceSettings?(settings: { voice?: string; speed?: number }): void;
  /** Called when the client transcribed locally (browser tier — Web Speech API).
   *  Bypasses server-side VAD + Whisper; finals go straight into the agent. */
  onTranscript?(text: string, isFinal: boolean): void;
  /** Called when the client disconnects or sends bye */
  close(): void;
}

export interface VoiceSessionContext {
  sessionId: string;
  /** Session intent. "chat" runs the full STT → LLM → TTS pipeline.
   *  "dictate" runs STT only — Whisper finals fire as `final` events for
   *  the client to consume into a textarea, but the agent + TTS never
   *  spin up. Saves token cost AND avoids playing a phantom reply when
   *  the user only wanted speech-to-text. Defaults to "chat" if missing. */
  mode?: "chat" | "dictate";
  /** Whether the client is doing STT on its own (real-browser Browser
   *  tier uses webkitSpeechRecognition and ships transcripts via the
   *  `transcript` message). When false, the server must run STT itself —
   *  Electron-Chromium can't reach Google's Speech API, so its renderer
   *  reports clientStt=false even on the Browser tier. Defaults to false
   *  if missing (safe — server runs STT, costs a Whisper round trip but
   *  produces correct output). */
  clientStt?: boolean;
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

// ── Optional WebRTC audio transport ──────────────────────────────────────
// When a client's `hello` requests transport:"webrtc", audio flows over a
// VoicePeer (mic in / TTS out) while this socket carries only SDP/ICE
// signaling + the existing JSON control events. Absent/"pcm" → unchanged
// binary-PCM-over-WS path. Mirrors the voice-peer.ts RtcIceCandidate shape
// (capital L in sdpMLineIndex); defined locally so the boot graph never
// pulls in werift via voice-peer.ts (the factory dynamic-imports it lazily).

/** Trickle ICE candidate wire shape — must match voice-peer.ts. */
interface RtcIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** The slice of VoicePeer the WS handler drives. */
interface VoicePeerLike {
  createOffer(): Promise<string>;
  applyAnswer(sdp: string): Promise<void>;
  addRemoteIce(c: RtcIceCandidate): Promise<void>;
  writeTtsPcm(frame: Int16Array, sampleRate: number): void;
  close(): Promise<void>;
}

type VoicePeerFactory = (handlers: {
  onLocalIce: (c: RtcIceCandidate | null) => void;
  onConnectionState: (s: string) => void;
  onMicPcm: (frame: Int16Array) => void;
}) => Promise<VoicePeerLike>;

// Lazy dynamic import keeps werift/opus out of the boot graph AND lets the
// unit test inject a fake peer via setVoicePeerFactory().
let peerFactory: VoicePeerFactory = async (h) => (await import("./voice-peer.js")).VoicePeer.create(h);

/** Register a custom peer factory (real default = lazy VoicePeer; tests inject a fake). */
export function setVoicePeerFactory(f: VoicePeerFactory): void {
  peerFactory = f;
}

export function setupVoiceWebSocket(server: Server, authToken: string, maxPayloadBytes: number): void {
  // Use noServer so we can route by path manually. When multiple
  // WebSocketServers attach via {server, path}, each one's upgrade handler
  // aborts requests whose path doesn't match ITS configured path with a
  // 400 response — not "leave the socket for the other WSS." So two
  // path-attached WSS on one server fight each other and the second one
  // never sees its requests. Standard ws-library workaround: noServer +
  // manual upgrade routing by path. maxPayload caps a single frame at the
  // configured upload limit (ws defaults to an unbounded-feeling 100 MiB).
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });

  server.on("upgrade", (req, socket, head) => {
    try {
      const u = new URL(req.url || "/", "http://localhost");
      if (u.pathname !== "/ws/voice") return; // not our path — leave socket alone
      // Reject cross-origin WS handshakes (cross-site WebSocket hijacking) —
      // browsers always send Origin; a non-loopback Origin is a cross-site page.
      // The paired mobile app sends no Origin and faces the token gate below;
      // tailnet-host Origins are admitted only when the bridge is enabled.
      const origin = req.headers.origin;
      if (origin && !isLoopbackOrigin(origin) && !(isBridgeEnabled() && isTailnetOrigin(origin))) { try { socket.destroy(); } catch {} return; }
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
    // Auth: query param or subprotocol "lax-auth,<token>".
    const url = new URL(req.url || "/", "http://localhost");
    let token = url.searchParams.get("token") || "";
    if (!token) {
      const protocols = req.headers["sec-websocket-protocol"] || "";
      const parts = protocols.split(",").map(s => s.trim());
      const idx = parts.indexOf("lax-auth");
      if (idx >= 0 && parts[idx + 1]) token = parts[idx + 1];
    }
    // Shared upgrade gate: operator token (loopback, unchanged) OR a valid
    // per-device bridge token when the bridge is enabled. Clean code + reason,
    // never a silent hang (constitution §7).
    const auth = authorizeUpgrade(token, authToken);
    if (!auth.ok) {
      const remote = req.socket.remoteAddress || "unknown";
      logger.warn(`[voice-ws] auth rejected from ${remote} — ${auth.reason}`);
      ws.close(WS_UNAUTHORIZED, auth.reason || "Unauthorized");
      return;
    }
    if (auth.principal === "device" && auth.deviceId) trackDeviceSocket(auth.deviceId, ws);
    logger.info(`[voice-ws] connection accepted from ${req.socket.remoteAddress} (${auth.principal})`);

    let sessionId = "";
    let session: VoiceSession | null = null;
    let closed = false;
    let peer: VoicePeerLike | null = null;
    let ttsSampleRate = 48000;
    let transport: "pcm" | "webrtc" = "pcm";

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

    // Single source of truth for tearing down the session + peer. Idempotent via
    // the `closed` flag: whoever fires first (ws-close OR a terminal rtc state)
    // wins, the other becomes a no-op — so ws-close-then-failed and
    // failed-then-ws-close both tear down exactly once. The binary/JSON handlers
    // and sendAudio/sendEvent all gate on `closed`, so flipping it here also stops
    // routing audio. The WS itself is NOT closed here: webrtc errors leave the
    // signaling socket open (mirrors the webrtc_setup_failed path), and the phone
    // drives reconnect by opening a fresh socket.
    const teardown = (): void => {
      if (closed) return;
      closed = true;
      try { session?.close(); } catch (e) {
        logger.warn(`[voice-ws] session close threw: ${(e as Error).message}`);
      }
      session = null;
      void peer?.close().catch((e: unknown) => {
        logger.warn(`[voice-ws] peer close threw: ${(e as Error).message}`);
      });
      peer = null;
      logger.info(`[voice-ws] session closed: ${sessionId || "(no-hello)"}`);
    };

    ws.on("message", async (data: RawData, isBinary: boolean) => {
      if (closed) return;

      if (isBinary) {
        // Audio is on WebRTC now — ignore inbound binary on the WS in that mode.
        if (transport === "webrtc") return;
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
          const mode: "chat" | "dictate" = msg.mode === "dictate" ? "dictate" : "chat";
          const clientStt = msg.clientStt === true;
          const reqTransport = msg.transport === "webrtc" ? "webrtc" : "pcm";

          // For webrtc, AUDIO leaves the WS: sendAudio routes TTS PCM to the
          // peer, and sendEvent snoops the TTS sample rate (carried on the
          // voice_ready event) so writeTtsPcm gets the right rate. The control
          // plane (sendEvent) ALWAYS stays on the WS — only audio moves.
          const webrtcSendAudio = (frame: Int16Array) => { peer?.writeTtsPcm(frame, ttsSampleRate); };
          const snoopEvent = (event: Record<string, unknown>) => {
            const r = event["ttsSampleRate"];
            if (typeof r === "number" && r > 0) ttsSampleRate = r;
            ctx.sendEvent(event);
          };

          session = sessionFactory({
            sessionId,
            mode,
            clientStt,
            sendAudio: reqTransport === "webrtc" ? webrtcSendAudio : ctx.sendAudio,
            sendEvent: reqTransport === "webrtc" ? snoopEvent : ctx.sendEvent,
          });
          ctx.sendEvent({ type: "ready", sessionId, mode });
          logger.info(`[voice-ws] session opened: ${sessionId} (mode=${mode}, transport=${reqTransport})`);

          if (reqTransport === "webrtc") {
            transport = "webrtc";
            // Build the peer and send the offer asynchronously. `session` is
            // already assigned so onMicPcm can reference it; webrtcSendAudio
            // closes over `peer` (assigned below) and the `peer?.` guard covers
            // the window before it lands. A setup error is surfaced, never swallowed.
            void (async () => {
              try {
                peer = await peerFactory({
                  onMicPcm: (f) => session?.onMicFrame(f),
                  onLocalIce: (c) => ctx.sendEvent({ type: "rtc_ice", candidate: c }),
                  onConnectionState: (s) => {
                    if (s === "failed") {
                      // Terminal: the media path is gone. Tell the client (once,
                      // while the WS is still open) and tear down the peer +
                      // session so the Opus codecs + RTP pacer don't leak. Guard
                      // on `closed` so a normal ws-close that already tore down
                      // doesn't trigger a second error/teardown.
                      if (closed) return;
                      logger.warn(`[voice-ws] rtc state: failed — tearing down`);
                      ctx.sendEvent({ type: "error", message: "webrtc_failed" });
                      teardown();
                    } else if (s === "disconnected") {
                      // Transient: ICE may auto-recover. Log only, no teardown.
                      logger.info(`[voice-ws] rtc state: disconnected (awaiting recovery)`);
                    } else {
                      // "closed" is normally our own teardown; the rest are
                      // progress states. Log, don't act.
                      logger.info(`[voice-ws] rtc state: ${s}`);
                    }
                  },
                });
                if (closed) { void peer.close().catch(() => {}); peer = null; return; }
                const sdp = await peer.createOffer();
                ctx.sendEvent({ type: "rtc_offer", sdp });
              } catch (e) {
                logger.error(`[voice-ws] webrtc setup failed: ${(e as Error).message}`);
                ctx.sendEvent({ type: "error", message: "webrtc_setup_failed" });
              }
            })();
          }
        } else if (msg.type === "rtc_answer") {
          try {
            const sdp = String(msg.sdp || "");
            if (sdp) await peer?.applyAnswer(sdp);
          } catch (e) {
            logger.warn(`[voice-ws] rtc_answer failed: ${(e as Error).message}`);
          }
        } else if (msg.type === "rtc_ice") {
          // null candidate = end-of-candidates; safe to ignore on receive.
          if (msg.candidate && typeof msg.candidate === "object") {
            try {
              await peer?.addRemoteIce(msg.candidate as RtcIceCandidate);
            } catch (e) {
              logger.warn(`[voice-ws] rtc_ice failed: ${(e as Error).message}`);
            }
          }
        } else if (msg.type === "eos") {
          session?.onEndOfSpeech?.();
        } else if (msg.type === "transcript") {
          // Client-side STT (browser tier). The browser ran SpeechRecognition
          // locally and is feeding us the transcript directly — no PCM, no
          // server-side Whisper. Pass through to the session.
          if (typeof msg.text === "string" && msg.text.length > 0) {
            session?.onTranscript?.(msg.text, msg.isFinal !== false);
          }
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
      // Shared idempotent teardown: a no-op if a terminal rtc "failed" already
      // cleaned up, otherwise it closes the session + peer. Either way `closed`
      // is set so the message handlers stop routing.
      teardown();
    });

    ws.on("error", (err) => {
      logger.warn(`[voice-ws] socket error: ${err.message}`);
    });
  });

  logger.info(`[voice-ws] Listening on /ws/voice (auth-gated)`);
}
