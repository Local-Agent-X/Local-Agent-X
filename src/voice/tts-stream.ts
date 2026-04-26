// Streaming Text-to-Speech — worker-thread edition.
//
// Runs sherpa-onnx Matcha TTS in a worker_thread so synthesis doesn't block
// Node's event loop. Without this, generateWithConfig() blocks for 300-800ms
// per sentence on CPU, during which incoming LLM token deltas queue at the
// network layer and arrive in bursts — making the assistant's text race
// ahead of its audio. With the worker, tokens stream smoothly and sentence
// N+1 starts synthesizing while sentence N is still streaming.
//
// Cancel semantics match the in-process API: .cancel() drops the queue and
// stops the currently-synthesizing sentence at its next callback tick. Fast
// enough to feel instantaneous for barge-in.
//
// Set VOICE_DIAG=1 to log per-chunk arrival timestamps + inter-arrival jitter,
// useful when debugging perceived audio quality regressions.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { TTSModelPaths } from "./tts-model-fetch.js";

import { createLogger } from "../logger.js";
const logger = createLogger("voice.tts-stream");

const DIAG = process.env.VOICE_DIAG === "1";

export type TTSCallback = {
  onAudio?: (pcm: Int16Array, sampleRate: number) => void;
  onSentenceEnd?: (text: string) => void;
  onIdle?: () => void;
  onError?: (err: Error) => void;
};

export interface StreamingTTS {
  speak(text: string): void;
  readonly sampleRate: number;
  cancel(): void;
  close(): void;
}

function resolveWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "tts-worker.js");
}

type WorkerMsg =
  | { type: "ready"; sampleRate: number }
  | { type: "audio"; pcm: Int16Array; sampleRate: number; t: number }
  | { type: "done"; id: number }
  | { type: "idle" }
  | { type: "error"; message: string };

export function createStreamingTTS(paths: TTSModelPaths, cb: TTSCallback = {}): StreamingTTS {
  const worker = new Worker(resolveWorkerPath());
  worker.on("error", (err) => cb.onError?.(err));

  const pending = new Map<number, string>();
  let nextId = 1;
  let sampleRate = paths.sampleRate;
  let closed = false;

  // Diagnostic state
  let chunkCount = 0;
  let lastArrivalMs = 0;
  let maxGapMs = 0;

  worker.on("message", (msg: WorkerMsg) => {
    if (closed) return;
    switch (msg.type) {
      case "ready":
        sampleRate = msg.sampleRate;
        break;
      case "audio": {
        if (DIAG) {
          chunkCount++;
          const now = Date.now();
          const workerToMain = now - msg.t;
          const interArrival = lastArrivalMs > 0 ? now - lastArrivalMs : 0;
          if (interArrival > maxGapMs) maxGapMs = interArrival;
          lastArrivalMs = now;
          if (chunkCount <= 5 || chunkCount % 25 === 0) {
            logger.info(`[tts-stream] chunk ${chunkCount} samples=${msg.pcm.length} ipc=${workerToMain}ms gap=${interArrival}ms maxGap=${maxGapMs}ms`);
          }
        }
        cb.onAudio?.(msg.pcm, msg.sampleRate);
        break;
      }
      case "done": {
        const text = pending.get(msg.id);
        pending.delete(msg.id);
        if (text) cb.onSentenceEnd?.(text);
        break;
      }
      case "idle":
        if (DIAG && chunkCount > 0) {
          logger.info(`[tts-stream] queue idle. total chunks=${chunkCount} maxGap=${maxGapMs}ms`);
          chunkCount = 0;
          lastArrivalMs = 0;
          maxGapMs = 0;
        }
        cb.onIdle?.();
        break;
      case "error":
        cb.onError?.(new Error(msg.message));
        break;
    }
  });

  worker.postMessage({ cmd: "init", paths });

  return {
    get sampleRate() { return sampleRate; },

    speak(text: string) {
      if (closed) return;
      const t = text.trim();
      if (!t) return;
      const id = nextId++;
      pending.set(id, t);
      worker.postMessage({ cmd: "speak", text: t, id });
    },

    cancel() {
      if (closed) return;
      pending.clear();
      worker.postMessage({ cmd: "cancel" });
    },

    close() {
      if (closed) return;
      closed = true;
      pending.clear();
      try { worker.postMessage({ cmd: "close" }); } catch {}
      setTimeout(() => { try { worker.terminate(); } catch {} }, 500).unref();
    },
  };
}
