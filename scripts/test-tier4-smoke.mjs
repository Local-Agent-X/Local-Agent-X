#!/usr/bin/env node
// Tier 4 native voice smoke test.
//
// Loads the Kokoro engine, synthesizes a short prompt, and prints latency +
// audio frame info. No Python sidecar involved. With --stt the produced
// audio is also fed through the Whisper transcriber to verify the no-Python
// STT path end-to-end (this is what the voice-session uses for the final
// utterance pass after VAD speech-end).
//
// Usage (run via tsx so the .ts files resolve):
//   npx tsx scripts/test-tier4-smoke.mjs                    (default voice, TTS only)
//   npx tsx scripts/test-tier4-smoke.mjs --voice af_bella   (named voice)
//   npx tsx scripts/test-tier4-smoke.mjs --device cpu       (force CPU EP)
//   npx tsx scripts/test-tier4-smoke.mjs --device dml --dtype fp16  (GPU TTS opt-in)
//   npx tsx scripts/test-tier4-smoke.mjs --write out.wav    (dump 24kHz PCM WAV)
//   npx tsx scripts/test-tier4-smoke.mjs --stt              (TTS -> Whisper round-trip)
//   npx tsx scripts/test-tier4-smoke.mjs --stt --whisper-device dml (force whisper EP, cpu fallback)
//   npx tsx scripts/test-tier4-smoke.mjs --stt --whisper-model small.en (pick variant: tiny.en|base.en|small.en)

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createTier4, tier4Readiness, snapshotTier4Diag } from "../src/voice/tier4/index.ts";

const args = process.argv.slice(2);
const arg = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
const flag = (k) => args.includes(k);

const prompt = arg("--text") || "Tier four is online. This is a quick smoke test of native ONNX voice.";
const voice = arg("--voice") || undefined;
const device = arg("--device") || undefined;
const dtype = arg("--dtype") || undefined;
const wavOut = arg("--write") || null;
const runStt = flag("--stt");
const whisperDevice = arg("--whisper-device") || undefined;

const r = tier4Readiness();
console.log("[tier4 smoke] readiness:", r);
if (!r.ready) {
  console.error("[tier4 smoke] not ready - fix missing deps and rerun");
  process.exit(2);
}

let firstAudioMs = null;
let totalSamples = 0;
let sampleRate = 24000;
const chunks = [];

const ttsDone = new Promise((resolve, reject) => {
  const tStart = performance.now();
  let tSpeak = 0;
  createTier4({ voice, device, dtype }, {
    onAudio: (pcm, sr) => {
      if (firstAudioMs == null) firstAudioMs = performance.now() - tSpeak;
      sampleRate = sr;
      totalSamples += pcm.length;
      chunks.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      console.log(`[tier4 smoke] +chunk samples=${pcm.length} sr=${sr}`);
    },
    onSentenceEnd: (t) => console.log(`[tier4 smoke] sentence-end: ${JSON.stringify(t)}`),
    onIdle: () => {
      const totalMs = performance.now() - tSpeak;
      const audioMs = (totalSamples / sampleRate) * 1000;
      const rtf = totalMs / Math.max(1, audioMs);
      console.log(`[tier4 smoke] DONE`);
      console.log(`[tier4 smoke] load+ready: ${(tSpeak - tStart).toFixed(0)}ms`);
      console.log(`[tier4 smoke] first-audio: ${firstAudioMs?.toFixed(0)}ms`);
      console.log(`[tier4 smoke] total wall: ${totalMs.toFixed(0)}ms`);
      console.log(`[tier4 smoke] audio duration: ${audioMs.toFixed(0)}ms`);
      console.log(`[tier4 smoke] realtime factor: ${rtf.toFixed(3)}x (lower = faster)`);
      resolve(null);
    },
    onError: (e) => reject(e),
  }).then((tts) => {
    tSpeak = performance.now();
    console.log(`[tier4 smoke] engine ready in ${(tSpeak - tStart).toFixed(0)}ms - speaking...`);
    ttsHandle = tts;
    tts.speak(prompt);
  }).catch(reject);
});

let ttsHandle = null;

const timer = setTimeout(() => {
  console.error("[tier4 smoke] TIMEOUT after 120s - engine never produced audio");
  process.exit(3);
}, 120_000);
timer.unref();

try {
  await ttsDone;
} catch (e) {
  console.error("[tier4 smoke] tts error:", e?.message || e);
  process.exit(1);
}

const diag = ttsHandle ? snapshotTier4Diag(ttsHandle) : null;
if (diag) {
  console.log(`[tier4 smoke] runtime: device=${diag.device} dtype=${diag.dtype} fellBack=${diag.fellBack}`);
}

if (wavOut) {
  const merged = Buffer.concat(chunks);
  const wav = makeWav(merged, sampleRate);
  writeFileSync(wavOut, wav);
  console.log(`[tier4 smoke] wrote ${wavOut} (${wav.length} bytes)`);
}

if (runStt) {
  try {
    await runWhisperRoundTrip();
  } catch (e) {
    console.error("[tier4 smoke] stt error:", e?.message || e);
    ttsHandle?.close();
    process.exit(4);
  }
}

ttsHandle?.close();
process.exit(0);

async function runWhisperRoundTrip() {
  const { ensureWhisperModelDownloaded, getWhisperModelPaths } =
    await import("../src/voice/whisper-model-fetch.ts");
  const { createWhisperTranscriber } = await import("../src/voice/whisper-stream.ts");

  const whisperModel = arg("--whisper-model") || undefined;
  const variantOpts = whisperModel ? { variant: whisperModel } : {};

  console.log("[tier4 smoke] stt: ensuring whisper model is on disk...");
  await ensureWhisperModelDownloaded(undefined, undefined, variantOpts);
  const paths = getWhisperModelPaths(variantOpts);

  const merged = Buffer.concat(chunks);
  const int16 = new Int16Array(merged.buffer, merged.byteOffset, merged.byteLength / 2);
  const resampled = resampleInt16(int16, sampleRate, 16000);
  console.log(`[tier4 smoke] stt: resampled ${int16.length}@${sampleRate} -> ${resampled.length}@16000`);
  console.log(`[tier4 smoke] stt: whisper variant=${paths.variant}`);

  const t0 = performance.now();
  const whisper = createWhisperTranscriber(paths, whisperDevice ? { provider: whisperDevice } : {});
  const text = await whisper.transcribe(resampled);
  const ms = performance.now() - t0;
  whisper.close();

  console.log(`[tier4 smoke] stt: transcribed in ${ms.toFixed(0)}ms`);
  if (whisper.runtime) {
    console.log(`[tier4 smoke] stt runtime: provider=${whisper.runtime.provider} fellBack=${whisper.runtime.fellBack}`);
  }
  console.log(`[tier4 smoke] stt prompt: ${JSON.stringify(prompt)}`);
  console.log(`[tier4 smoke] stt result: ${JSON.stringify(text)}`);
  const overlap = wordOverlap(prompt, text);
  console.log(`[tier4 smoke] stt word-overlap: ${(overlap * 100).toFixed(0)}%`);
  if (overlap < 0.5) {
    throw new Error(`stt word-overlap below 50% (${(overlap * 100).toFixed(0)}%) - likely a regression`);
  }
}

function resampleInt16(input, srcRate, dstRate) {
  if (srcRate === dstRate) return input;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = srcIdx - i0;
    out[i] = (input[i0] * (1 - t) + input[i1] * t) | 0;
  }
  return out;
}

function wordOverlap(a, b) {
  const norm = (s) => new Set(
    String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean),
  );
  const wa = norm(a);
  const wb = norm(b);
  if (wa.size === 0) return 0;
  let hits = 0;
  for (const w of wa) if (wb.has(w)) hits++;
  return hits / wa.size;
}

function makeWav(pcm, sr) {
  const dataLen = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}
