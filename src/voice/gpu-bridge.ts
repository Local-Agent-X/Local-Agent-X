// GPU sidecar bridge — Node WebSocket client to the Python streaming voice
// service running at ws://127.0.0.1:7008/voice (or LAX_VOICE_PORT).
//
// Matches the surface of the in-process StreamingSTT + StreamingTTS so
// voice-session can pick one implementation or the other behind a flag.
// The Python sidecar handles VAD + STT + TTS itself, so this bridge also
// replaces VAD on the GPU path — there's only one VAD running, server-side.
//
// Lifecycle: a single shared connection per Node process, multiplexed
// across all active voice sessions. The current voice-test page only ever
// runs one session at a time, so multiplexing is light. If we ever need
// per-session isolation we'll switch to one connection per session.

import WebSocket from "ws";

import { createLogger } from "../logger.js";
const logger = createLogger("voice.gpu-bridge");

export type GPUBridgeCallbacks = {
  onReady?: (gpu: string) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onPartial?: (text: string) => void;
  onFinal?: (text: string, ms: number) => void;
  onAudioChunk?: (pcm: Int16Array, sampleRate: number, sentenceId: number, isFinal: boolean) => void;
  onAudioDone?: (sentenceId: number, ms: number, cancelled: boolean) => void;
  onError?: (msg: string) => void;
  onDisconnect?: () => void;
};

export interface GPUBridge {
  ready(): Promise<void>;
  /** Push a 16kHz Int16 mic frame. Server-side VAD handles endpointing. */
  feedAudio(pcm: Int16Array): void;
  /** Force the server to emit a final transcript now (e.g. user toggled mute). */
  flush(): void;
  /** Queue a sentence for synthesis. Audio chunks come back via onAudioChunk.
   *  Optional voice + speed override per-call (otherwise the sidecar uses
   *  its env-configured defaults). */
  speak(text: string, sentenceId: number, opts?: { voice?: string; speed?: number }): void;
  /** Drop the TTS queue + abort current synthesis. */
  cancelTTS(): void;
  /** Wipe all server-side state (audio buffer + TTS queue). */
  reset(): void;
  close(): void;
  readonly ttsSampleRate: number;
  readonly micSampleRate: number;
}

interface ServerMsg {
  type: string;
  // ready
  stt?: boolean; tts?: boolean; gpu?: string;
  // partial / final
  text?: string;
  ms?: number;
  // audio
  pcm?: string;
  sr?: number;
  id?: number;
  final?: boolean;
  cancelled?: boolean;
  // error
  message?: string;
}

const DEFAULT_PORT = parseInt(process.env.LAX_VOICE_PORT || "7008", 10);

export function createGPUBridge(cb: GPUBridgeCallbacks = {}, port: number = DEFAULT_PORT): GPUBridge {
  let ws: WebSocket | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((e: Error) => void) | null = null;
  const readyPromise = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  let closed = false;
  let connected = false;

  function connect(): void {
    const url = `ws://127.0.0.1:${port}/voice`;
    logger.info(`[gpu-bridge] connecting to ${url}`);
    ws = new WebSocket(url);

    ws.on("open", () => {
      connected = true;
      logger.info(`[gpu-bridge] open — sending init`);
      send({ cmd: "init" });
    });

    ws.on("message", (data: WebSocket.RawData) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        logger.warn(`[gpu-bridge] bad json from server: ${(e as Error).message}`);
        return;
      }
      handle(msg);
    });

    ws.on("close", (code) => {
      const wasConnected = connected;
      connected = false;
      // Suppress the close warn when we never opened — the matching error
      // event already logged (or quietly debug-logged for ECONNREFUSED),
      // and a second "ws closed code=1006" line is just noise on the path
      // where the sidecar isn't running by design (GPU mode is opt-in).
      if (wasConnected) logger.warn(`[gpu-bridge] ws closed code=${code}`);
      cb.onDisconnect?.();
      if (!closed && readyReject) readyReject(new Error(`sidecar disconnected (code ${code})`));
    });

    ws.on("error", (err: Error & { code?: string }) => {
      // ECONNREFUSED is the expected shape when the Python sidecar isn't
      // running. GPU voice is opt-in from settings, so a refused connect
      // is "user hasn't started the sidecar," not a fault — log at debug
      // so the console stays clean. Any other error class (port mismatch,
      // TLS failure, peer reset mid-session) still surfaces at warn.
      if (err.code === "ECONNREFUSED") {
        logger.debug(`[gpu-bridge] sidecar not running on :${port} (GPU mode is opt-in)`);
      } else {
        logger.warn(`[gpu-bridge] ws error: ${err.message}`);
      }
      if (!closed && readyReject) readyReject(err);
    });
  }

  function handle(msg: ServerMsg): void {
    switch (msg.type) {
      case "ready":
        logger.info(`[gpu-bridge] sidecar ready stt=${msg.stt} tts=${msg.tts} gpu=${msg.gpu || "?"}`);
        cb.onReady?.(msg.gpu || "");
        if (readyResolve) { readyResolve(); readyResolve = null; readyReject = null; }
        break;
      case "vad_start":
        cb.onSpeechStart?.();
        break;
      case "vad_end":
        cb.onSpeechEnd?.();
        break;
      case "partial":
        if (msg.text) cb.onPartial?.(msg.text);
        break;
      case "final":
        cb.onFinal?.(msg.text || "", msg.ms || 0);
        break;
      case "audio_chunk": {
        if (!msg.pcm) return;
        const buf = Buffer.from(msg.pcm, "base64");
        const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
        cb.onAudioChunk?.(pcm, msg.sr || 24000, msg.id || 0, !!msg.final);
        break;
      }
      case "audio_done":
        cb.onAudioDone?.(msg.id || 0, msg.ms || 0, !!msg.cancelled);
        break;
      case "error":
        logger.warn(`[gpu-bridge] server error: ${msg.message}`);
        cb.onError?.(msg.message || "unknown");
        break;
      case "pong":
        break;
      default:
        logger.warn(`[gpu-bridge] unknown server msg type: ${msg.type}`);
    }
  }

  function send(obj: Record<string, unknown>): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) { logger.warn(`[gpu-bridge] send failed: ${(e as Error).message}`); }
  }

  connect();

  return {
    get ttsSampleRate() { return 24000; },
    get micSampleRate() { return 16000; },

    ready() { return readyPromise; },

    feedAudio(pcm: Int16Array) {
      if (!connected || closed) return;
      // Base64 encode the Int16 buffer for the JSON-over-WS protocol.
      // Binary frames would be lighter but mixing binary+JSON on the same
      // WS doubles the parser complexity; the audio rate is low (16kHz
      // mono int16 = 32KB/s, ~10x smaller than typical WS payloads).
      const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
      send({ cmd: "audio", pcm: b64 });
    },

    flush() { send({ cmd: "flush" }); },
    speak(text: string, sentenceId: number, opts?: { voice?: string; speed?: number }) {
      const msg: Record<string, unknown> = { cmd: "tts", text, id: sentenceId };
      if (opts?.voice) msg.voice = opts.voice;
      if (opts?.speed !== undefined) msg.speed = opts.speed;
      send(msg);
    },
    cancelTTS() { send({ cmd: "cancel_tts" }); },
    reset() { send({ cmd: "reset" }); },

    close() {
      closed = true;
      try { ws?.close(); } catch {}
    },
  };
}
