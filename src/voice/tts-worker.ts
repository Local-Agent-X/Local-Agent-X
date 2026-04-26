// Worker-thread host for sherpa-onnx TTS.
//
// generateWithConfig() is a synchronous WASM call that blocks the Node event
// loop for 300-800ms per sentence. When it blocks, incoming LLM token deltas
// queue at the network layer and arrive in bursts, making the assistant's
// text race ahead of its audio. Hosting synthesis in a worker keeps the main
// loop responsive so tokens flow smoothly and sentence N+1 starts
// synthesizing while sentence N is still streaming to the browser.
//
// First attempt at this design (stashed 2026-04-24) audibly degraded
// playback. This version adds diagnostic timestamps on both sides — set
// VOICE_DIAG=1 to surface them — so we can see whether the regression came
// from postMessage IPC jitter, transferable-buffer detachment timing, or
// something else.
//
// Protocol (parentPort messages):
//   Main → worker:
//     { cmd: "init",   paths: TTSModelPaths }
//     { cmd: "speak",  text: string, id: number }
//     { cmd: "cancel" }                          // drop queue + stop current
//     { cmd: "close" }
//   Worker → main:
//     { type: "ready",  sampleRate: number }
//     { type: "audio",  pcm: Int16Array, sampleRate: number, t: number }
//     { type: "done",   id: number }
//     { type: "idle" }
//     { type: "error",  message: string }

import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import type { TTSModelPaths } from "./tts-model-fetch.js";

import { createLogger } from "../logger.js";
const logger = createLogger("voice.tts-worker");

if (!parentPort) throw new Error("tts-worker must run as a worker_thread");

const requireCJS = createRequire(import.meta.url);
const DIAG = process.env.VOICE_DIAG === "1";

interface SherpaOfflineTts {
  sampleRate: number;
  generateWithConfig(text: string, config: {
    sid?: number;
    speed?: number;
    callback?: (samples: Float32Array, n: number, progress: number) => number;
  }): { samples: Float32Array; sampleRate: number };
  free(): void;
}

let tts: SherpaOfflineTts | null = null;
let sampleRate = 22050;

type Job = { text: string; id: number };
const queue: Job[] = [];
let draining = false;
let cancelCurrent = false;
let cancelAll = false;
let closed = false;

function floatToInt16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    let s = f32[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function init(paths: TTSModelPaths): void {
  const sherpa = requireCJS("sherpa-onnx") as {
    createOfflineTts: (config: unknown) => SherpaOfflineTts;
  };
  // sherpa-onnx accesses fields on every model-family sub-config without
  // null-guards, so we populate empty placeholders for unused families.
  // Only the matcha block carries real paths.
  const emptyVits = { model: "", lexicon: "", tokens: "", dataDir: "", noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 };
  const emptyKokoro = { model: "", voices: "", tokens: "", dataDir: "", dictDir: "", lengthScale: 1.0, lexicon: "" };
  tts = sherpa.createOfflineTts({
    offlineTtsModelConfig: {
      offlineTtsVitsModelConfig: emptyVits,
      offlineTtsMatchaModelConfig: {
        acousticModel: paths.acousticModel,
        vocoder: paths.vocoder,
        tokens: paths.tokens,
        lexicon: "",
        dataDir: paths.dataDir, // espeak-ng-data — required for G2P
        noiseScale: 0.667,
        lengthScale: 1.0,
      },
      offlineTtsKokoroModelConfig: emptyKokoro,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    maxNumSentences: 1,
    silenceScale: 0.2,
  });
  sampleRate = tts.sampleRate || paths.sampleRate;
  parentPort!.postMessage({ type: "ready", sampleRate });
  if (DIAG) logger.info(`[tts-worker] ready sampleRate=${sampleRate}`);
}

async function drain(): Promise<void> {
  if (draining || closed || !tts) return;
  draining = true;
  try {
    while (queue.length > 0 && !closed) {
      if (cancelAll) {
        cancelAll = false;
        queue.length = 0;
        break;
      }
      const job = queue.shift()!;
      cancelCurrent = false;
      const t0 = Date.now();
      // Matcha emits the full sentence in a single callback at end-of-synthesis,
      // and the WASM call blocks the worker's event loop the whole time —
      // which means cancel messages from main thread can't be processed
      // until WASM returns. If we ship audio inside the callback, the chunk
      // gets out the door before we can react to a barge-in.
      // Solution: buffer chunks during synthesis, yield after WASM returns
      // to drain pending messages, then ship only if no cancel landed.
      const buffered: Int16Array[] = [];
      let totalSamples = 0;
      try {
        tts.generateWithConfig(job.text, {
          sid: 0,
          speed: 1.0,
          callback: (samples) => {
            if (closed || cancelCurrent || cancelAll) return 0;
            if (samples.length > 0) {
              buffered.push(floatToInt16(samples));
              totalSamples += samples.length;
            }
            return 1;
          },
        });
        // Process any cancel/close messages that arrived during synthesis
        await new Promise<void>((r) => setImmediate(r));

        const dropped = closed || cancelCurrent || cancelAll;
        if (DIAG) {
          const dt = Date.now() - t0;
          const audioDurMs = Math.round(totalSamples / sampleRate * 1000);
          logger.info(`[tts-worker] sentence done id=${job.id} synth=${dt}ms audio=${audioDurMs}ms chunks=${buffered.length} dropped=${dropped} text="${job.text.slice(0, 40)}"`);
        }
        if (!dropped) {
          for (const pcm of buffered) {
            parentPort!.postMessage(
              { type: "audio", pcm, sampleRate, t: Date.now() },
              [pcm.buffer as ArrayBuffer],
            );
          }
          if (!closed) parentPort!.postMessage({ type: "done", id: job.id });
        }
      } catch (e) {
        parentPort!.postMessage({ type: "error", message: (e as Error).message || String(e) });
      }
      // One more yield between sentences to keep cancel processing snappy
      await new Promise<void>((r) => setImmediate(r));
    }
  } finally {
    draining = false;
    if (!closed && queue.length === 0) parentPort!.postMessage({ type: "idle" });
  }
}

parentPort.on("message", (msg: { cmd: string; paths?: TTSModelPaths; text?: string; id?: number }) => {
  try {
    if (msg.cmd === "init" && msg.paths) {
      init(msg.paths);
    } else if (msg.cmd === "speak" && typeof msg.text === "string" && typeof msg.id === "number") {
      queue.push({ text: msg.text, id: msg.id });
      if (!draining) drain();
    } else if (msg.cmd === "cancel") {
      cancelCurrent = true;
      cancelAll = true;
      queue.length = 0;
    } else if (msg.cmd === "close") {
      closed = true;
      cancelCurrent = true;
      cancelAll = true;
      queue.length = 0;
      try { tts?.free(); } catch {}
      process.exit(0);
    }
  } catch (e) {
    parentPort!.postMessage({ type: "error", message: (e as Error).message || String(e) });
  }
});
