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
//   npx tsx scripts/test-tier4-smoke.mjs --speed 1.2        (synthesis speed, 0.5-2.0)
//   npx tsx scripts/test-tier4-smoke.mjs --device cpu       (force CPU EP)
//   npx tsx scripts/test-tier4-smoke.mjs --device dml --dtype fp16  (GPU TTS opt-in)
//   npx tsx scripts/test-tier4-smoke.mjs --write out.wav    (dump 24kHz PCM WAV)
//   npx tsx scripts/test-tier4-smoke.mjs --stt              (TTS -> Whisper round-trip)
//   npx tsx scripts/test-tier4-smoke.mjs --stt --whisper-device dml (force whisper EP, cpu fallback)
//   npx tsx scripts/test-tier4-smoke.mjs --stt --whisper-model small.en (pick variant: tiny.en|base.en|small.en)
//
// Sanity gates (any failure exits 4 with a one-line GATE FAIL: summary):
//   --min-audio-ms <n>          require >= N ms of synthesised audio
//   --max-first-audio-ms <n>    require first chunk within N ms
//   --max-rtf <n>               require realtime factor <= N (lower = faster)
//   --min-stt-overlap <pct>     with --stt, require word-overlap >= N% (default 50)
//   --strict                    shorthand: 1500 / 4000 / 1.0 / 50

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createTier4, tier4Readiness, snapshotTier4Diag, isValidKokoroVoice } from "../src/voice/tier4/index.ts";
import { SPEED_MIN, SPEED_MAX } from "../src/voice/tier4/env.ts";
import { VALID_WHISPER_VARIANTS } from "../src/voice/whisper-model-fetch.ts";
import { VALID_WHISPER_PROVIDERS } from "../src/voice/whisper-stream.ts";

const args = process.argv.slice(2);
const arg = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
const flag = (k) => args.includes(k);
const argNum = (k) => {
  const v = arg(k);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const prompt = arg("--text") || "Tier four is online. This is a quick smoke test of native ONNX voice.";
let voice = arg("--voice") || undefined;
if (voice && !isValidKokoroVoice(voice)) {
  console.error(`[tier4 smoke] --voice "${voice}" is not a known Kokoro voice; falling back to default`);
  voice = undefined;
}
// --speed shares the same SPEED_MIN/SPEED_MAX bounds the env helper and the
// settings reader enforce. An out-of-range value used to silently flow into
// kokoro-js and either distort phonemes or throw an opaque ORT error; now
// the smoke test fails fast with a one-line reason naming the bound.
const speedArg = arg("--speed");
let speed;
if (speedArg != null) {
  const sn = Number(speedArg);
  if (!Number.isFinite(sn)) {
    console.error(`[tier4 smoke] --speed "${speedArg}" is not a number`);
    process.exit(2);
  }
  if (sn < SPEED_MIN || sn > SPEED_MAX) {
    console.error(`[tier4 smoke] --speed ${sn} out of range [${SPEED_MIN}..${SPEED_MAX}]`);
    process.exit(2);
  }
  speed = sn;
}
const device = arg("--device") || undefined;
const dtype = arg("--dtype") || undefined;
const wavOut = arg("--write") || null;
const runStt = flag("--stt");
const whisperDeviceRaw = arg("--whisper-device") || undefined;
const whisperDevice = (() => {
  if (!whisperDeviceRaw) return undefined;
  const lower = whisperDeviceRaw.toLowerCase();
  if (!VALID_WHISPER_PROVIDERS.has(lower)) {
    console.error(`[tier4 smoke] --whisper-device "${whisperDeviceRaw}" not in [${[...VALID_WHISPER_PROVIDERS].join("|")}]`);
    process.exit(2);
  }
  return lower;
})();

const strict = flag("--strict");
const gateMinAudioMs = argNum("--min-audio-ms") ?? (strict ? 1500 : null);
const gateMaxFirstAudioMs = argNum("--max-first-audio-ms") ?? (strict ? 4000 : null);
const gateMaxRtf = argNum("--max-rtf") ?? (strict ? 1.0 : null);
// Default 50 keeps the historical hard-coded floor; --strict surfaces the
// same number explicitly so CI logs document what's enforced.
const gateMinSttOverlap = argNum("--min-stt-overlap") ?? 50;

const gateFailures = [];

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
  createTier4({ voice, device, dtype, speed }, {
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
      if (gateMinAudioMs != null && audioMs < gateMinAudioMs) {
        gateFailures.push(`audio ${audioMs.toFixed(0)}ms < min ${gateMinAudioMs}ms`);
      }
      if (gateMaxFirstAudioMs != null && firstAudioMs != null && firstAudioMs > gateMaxFirstAudioMs) {
        gateFailures.push(`first-audio ${firstAudioMs.toFixed(0)}ms > max ${gateMaxFirstAudioMs}ms`);
      }
      if (gateMaxRtf != null && rtf > gateMaxRtf) {
        gateFailures.push(`rtf ${rtf.toFixed(3)} > max ${gateMaxRtf}`);
      }
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
    // Collect into gateFailures so a TTS gate failure that happened earlier
    // also surfaces in the final summary instead of being swallowed by an
    // STT error exit. Both report together below.
    const msg = e?.message || String(e);
    console.error("[tier4 smoke] stt error:", msg);
    gateFailures.push("stt: " + msg);
  }
}

ttsHandle?.close();

if (gateFailures.length > 0) {
  console.error(`[tier4 smoke] GATE FAIL: ${gateFailures.join(" | ")}`);
  process.exit(4);
}

process.exit(0);

async function runWhisperRoundTrip() {
  const { ensureWhisperModelDownloaded, getWhisperModelPaths } =
    await import("../src/voice/whisper-model-fetch.ts");
  const { createWhisperTranscriber } = await import("../src/voice/whisper-stream.ts");

  const whisperModelRaw = arg("--whisper-model") || undefined;
  let whisperModel;
  if (whisperModelRaw) {
    const lower = whisperModelRaw.toLowerCase();
    if (!VALID_WHISPER_VARIANTS.has(lower)) {
      throw new Error(
        `--whisper-model "${whisperModelRaw}" not in [${[...VALID_WHISPER_VARIANTS].join("|")}]`,
      );
    }
    whisperModel = lower;
  }
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
  const overlapPct = overlap * 100;
  console.log(`[tier4 smoke] stt word-overlap: ${overlapPct.toFixed(0)}%`);
  if (overlapPct < gateMinSttOverlap) {
    throw new Error(`stt word-overlap ${overlapPct.toFixed(0)}% < min ${gateMinSttOverlap}% - likely a regression`);
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
