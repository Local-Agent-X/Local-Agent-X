// OpenAI Realtime API WebSocket client.
//
// Wraps a single connection to wss://api.openai.com/v1/realtime. Speaks the
// subset of the protocol the full-duplex bridge needs: session.update,
// input_audio_buffer.append/commit, response.create/cancel. Inbound events
// are demuxed to typed callbacks.
//
// Audio I/O contract:
//   - input:  base64-encoded little-endian PCM16 mono @ 24kHz
//   - output: base64-encoded little-endian PCM16 mono @ 24kHz
// The bridge resamples 16kHz mic input to 24kHz before calling sendAudio().
//
// Server-side VAD (turn_detection: {type:"server_vad"}) is enabled so the
// model handles its own turn-taking and barge-in. Browser VAD events are
// still wired through realtime-session for UI consistency.

import WebSocket from "ws";

import { createLogger } from "../../logger.js";
const logger = createLogger("voice.realtime");

const REALTIME_URL = "wss://api.openai.com/v1/realtime";
export const DEFAULT_MODEL = "gpt-4o-realtime-preview-2024-12-17";
export const DEFAULT_VOICE = "alloy";
export const VALID_VOICES = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);

export interface RealtimeClientOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  /** System-style instructions sent in session.update.instructions. */
  instructions?: string;
}

export interface RealtimeClientCallbacks {
  onSessionCreated?: () => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  onAudioDelta?: (pcm24k: Int16Array) => void;
  onTranscriptDelta?: (text: string) => void;
  onResponseDone?: () => void;
  onError?: (message: string) => void;
  onClose?: (code: number) => void;
}

export interface RealtimeClient {
  ready(): Promise<void>;
  /** Append a chunk of 24kHz PCM16 mono to the input buffer (base64-wire). */
  sendAudio(pcm24k: Int16Array): void;
  /** Manually commit the input buffer. With server VAD enabled this is
   *  rarely needed — the server commits + responds on its own. */
  commitInput(): void;
  /** Ask the model to start a response now. Server VAD usually fires this
   *  for us, but exposing it lets the bridge force a turn (e.g. after a
   *  client `eos` control message). */
  createResponse(): void;
  /** Barge-in: tell the model to stop generating + drop queued audio. */
  cancelResponse(): void;
  close(): void;
}

interface ServerEvent {
  type: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string; type?: string; code?: string };
  // session.created etc. carry more fields we don't need here.
}

export function createRealtimeClient(
  opts: RealtimeClientOptions,
  cb: RealtimeClientCallbacks = {},
): RealtimeClient {
  const model = opts.model || DEFAULT_MODEL;
  const voice = opts.voice && VALID_VOICES.has(opts.voice) ? opts.voice : DEFAULT_VOICE;
  const url = `${REALTIME_URL}?model=${encodeURIComponent(model)}`;

  let ws: WebSocket | null = null;
  let closed = false;
  let sessionReady = false;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((e: Error) => void) | null = null;
  const readyPromise = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  function send(obj: Record<string, unknown>): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      logger.warn(`[realtime-client] send failed: ${(e as Error).message}`);
    }
  }

  function handle(evt: ServerEvent): void {
    switch (evt.type) {
      case "session.created":
        // Push our config now that the server has accepted the connection.
        // turn_detection: server_vad lets the model handle endpointing +
        // barge-in cancellation entirely on its side.
        send({
          type: "session.update",
          session: {
            modalities: ["audio", "text"],
            voice,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: { type: "server_vad" },
            instructions: opts.instructions ?? "",
            // TODO(v2): wire tools via session.update tools field
          },
        });
        sessionReady = true;
        cb.onSessionCreated?.();
        if (readyResolve) { readyResolve(); readyResolve = null; readyReject = null; }
        break;
      case "session.updated":
        break;
      case "input_audio_buffer.speech_started":
        cb.onSpeechStarted?.();
        break;
      case "input_audio_buffer.speech_stopped":
        cb.onSpeechStopped?.();
        break;
      case "response.audio.delta":
        if (evt.delta) {
          // Lazy import to keep the resampler module-level free of cycles.
          import("./resampler.js").then(({ base64ToInt16 }) => {
            cb.onAudioDelta?.(base64ToInt16(evt.delta!));
          }).catch((e) => logger.warn(`[realtime-client] decode failed: ${(e as Error).message}`));
        }
        break;
      case "response.audio_transcript.delta":
        if (evt.delta) cb.onTranscriptDelta?.(evt.delta);
        break;
      case "response.done":
        cb.onResponseDone?.();
        break;
      case "error": {
        const msg = evt.error?.message || "unknown realtime error";
        logger.warn(`[realtime-client] server error: ${msg}`);
        cb.onError?.(msg);
        if (!sessionReady && readyReject) {
          readyReject(new Error(msg));
          readyReject = null; readyResolve = null;
        }
        break;
      }
      default:
        // Many events (response.created, rate_limits.updated, conversation
        // item lifecycle, etc.) we just don't need. Don't log every one —
        // it's noisy at info level.
        break;
    }
  }

  function connect(): void {
    logger.info(`[realtime-client] connecting model=${model} voice=${voice}`);
    ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    ws.on("open", () => {
      logger.info(`[realtime-client] ws open — waiting for session.created`);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      let evt: ServerEvent;
      try {
        evt = JSON.parse(data.toString()) as ServerEvent;
      } catch (e) {
        logger.warn(`[realtime-client] bad json: ${(e as Error).message}`);
        return;
      }
      handle(evt);
    });

    ws.on("close", (code) => {
      logger.warn(`[realtime-client] ws closed code=${code}`);
      cb.onClose?.(code);
      if (!sessionReady && readyReject) {
        readyReject(new Error(`realtime ws closed before session.created (code ${code})`));
        readyReject = null; readyResolve = null;
      }
    });

    ws.on("error", (err) => {
      logger.warn(`[realtime-client] ws error: ${err.message}`);
      if (!sessionReady && readyReject) {
        readyReject(err);
        readyReject = null; readyResolve = null;
      }
    });
  }

  connect();

  return {
    ready() { return readyPromise; },

    sendAudio(pcm24k: Int16Array) {
      if (closed || !pcm24k.length) return;
      const b64 = Buffer.from(pcm24k.buffer, pcm24k.byteOffset, pcm24k.byteLength).toString("base64");
      send({ type: "input_audio_buffer.append", audio: b64 });
    },

    commitInput() { send({ type: "input_audio_buffer.commit" }); },

    createResponse() { send({ type: "response.create" }); },

    cancelResponse() { send({ type: "response.cancel" }); },

    close() {
      if (closed) return;
      closed = true;
      try { ws?.close(); } catch {}
    },
  };
}
