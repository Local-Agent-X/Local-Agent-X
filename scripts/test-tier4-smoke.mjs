#!/usr/bin/env node
// Tier 4 native voice smoke test.
//
// Loads the Kokoro engine, synthesizes a short prompt, and prints latency +
// audio frame info. No Python sidecar involved.
//
// Usage (run via tsx so the .ts files resolve):
//   npx tsx scripts/test-tier4-smoke.mjs                    (default voice)
//   npx tsx scripts/test-tier4-smoke.mjs --voice af_bella   (named voice)
//   npx tsx scripts/test-tier4-smoke.mjs --device cpu       (force CPU EP)
//   npx tsx scripts/test-tier4-smoke.mjs --write out.wav    (dump 24kHz PCM WAV)

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createTier4, tier4Readiness } from "../src/voice/tier4/index.ts";

const args = process.argv.slice(2);
const arg = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};

const prompt = arg("--text") || "Tier four is online. This is a quick smoke test of native ONNX voice.";
const voice = arg("--voice") || undefined;
const device = arg("--device") || undefined;
const wavOut = arg("--write") || null;

const r = tier4Readiness();
console.log("[tier4 smoke] readiness:", r);
if (!r.ready) {
  console.error("[tier4 smoke] not ready — fix missing deps and rerun");
  process.exit(2);
}

let firstAudioMs = null;
let totalSamples = 0;
let sampleRate = 24000;
const chunks = [];

const tStart = performance.now();
const tts = await createTier4({ voice, device }, {
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
    if (wavOut) {
      const merged = Buffer.concat(chunks);
      const wav = makeWav(merged, sampleRate);
      writeFileSync(wavOut, wav);
      console.log(`[tier4 smoke] wrote ${wavOut} (${wav.length} bytes)`);
    }
    tts.close();
    process.exit(0);
  },
  onError: (e) => {
    console.error("[tier4 smoke] error:", e?.message || e);
    process.exit(1);
  },
});

const tSpeak = performance.now();
console.log(`[tier4 smoke] engine ready in ${(tSpeak - tStart).toFixed(0)}ms — speaking…`);
tts.speak(prompt);

function makeWav(pcm, sr) {
  const dataLen = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);          // PCM
  header.writeUInt16LE(1, 22);          // mono
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}

setTimeout(() => {
  console.error("[tier4 smoke] TIMEOUT after 120s — engine never produced audio");
  process.exit(3);
}, 120_000).unref();
