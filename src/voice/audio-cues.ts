/**
 * Spatial Audio Cues — different notification sounds for agent events.
 * Generates WAV tones programmatically (no external sound files needed).
 */

import { writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const TMP_DIR = join(getLaxDir(), "voice-tmp");
const CACHE_DIR = join(getLaxDir(), "audio-cues");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

export type CueEvent =
  | "ready"           // agent ready to listen
  | "listening"       // started recording
  | "thinking"        // processing request
  | "response"        // response ready
  | "error"           // error occurred
  | "complete"        // task completed
  | "notification"    // general notification
  | "wake"            // wake word detected
  | "interrupt";      // speech interrupted

interface ToneSpec {
  frequencies: number[];  // Hz for each segment
  durations: number[];    // seconds for each segment
  volume: number;         // 0-1
  waveform: "sine" | "square" | "triangle";
}

const CUE_SPECS: Record<CueEvent, ToneSpec> = {
  ready:        { frequencies: [440, 660],       durations: [0.1, 0.15],  volume: 0.3, waveform: "sine" },
  listening:    { frequencies: [880],            durations: [0.08],       volume: 0.25, waveform: "sine" },
  thinking:     { frequencies: [330, 440, 330],  durations: [0.1, 0.1, 0.1], volume: 0.2, waveform: "triangle" },
  response:     { frequencies: [660, 880],       durations: [0.08, 0.12], volume: 0.3, waveform: "sine" },
  error:        { frequencies: [220, 165],       durations: [0.15, 0.2],  volume: 0.4, waveform: "square" },
  complete:     { frequencies: [523, 659, 784],  durations: [0.1, 0.1, 0.15], volume: 0.3, waveform: "sine" },
  notification: { frequencies: [587, 784],       durations: [0.08, 0.12], volume: 0.25, waveform: "sine" },
  wake:         { frequencies: [440, 554, 659],  durations: [0.06, 0.06, 0.1], volume: 0.3, waveform: "sine" },
  interrupt:    { frequencies: [440, 220],       durations: [0.05, 0.08], volume: 0.35, waveform: "square" },
};

/** Generate a WAV buffer for a tone sequence */
function generateTone(spec: ToneSpec): Buffer {
  const SAMPLE_RATE = 44100;
  const BITS = 16;

  let totalSamples = 0;
  for (const d of spec.durations) totalSamples += Math.floor(d * SAMPLE_RATE);

  const data = Buffer.alloc(totalSamples * 2); // 16-bit mono
  let offset = 0;

  for (let seg = 0; seg < spec.frequencies.length; seg++) {
    const freq = spec.frequencies[seg];
    const samples = Math.floor(spec.durations[seg] * SAMPLE_RATE);

    for (let i = 0; i < samples; i++) {
      const t = i / SAMPLE_RATE;
      let sample: number;

      // Apply fade in/out (5ms)
      const fadeLen = Math.floor(0.005 * SAMPLE_RATE);
      let envelope = 1;
      if (i < fadeLen) envelope = i / fadeLen;
      if (i > samples - fadeLen) envelope = (samples - i) / fadeLen;

      switch (spec.waveform) {
        case "square":
          sample = Math.sin(2 * Math.PI * freq * t) > 0 ? 1 : -1;
          break;
        case "triangle":
          sample = (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * freq * t));
          break;
        default: // sine
          sample = Math.sin(2 * Math.PI * freq * t);
      }

      const value = Math.round(sample * spec.volume * envelope * 32767);
      data.writeInt16LE(Math.max(-32768, Math.min(32767, value)), offset);
      offset += 2;
    }
  }

  // Build WAV file
  const header = Buffer.alloc(44);
  const dataSize = data.length;
  const fileSize = 36 + dataSize;

  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);        // fmt chunk size
  header.writeUInt16LE(1, 20);         // PCM
  header.writeUInt16LE(1, 22);         // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);         // block align
  header.writeUInt16LE(BITS, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, data]);
}

/** Get WAV buffer for a cue event (cached) */
export function getCueAudio(event: CueEvent): Buffer {
  const cachePath = join(CACHE_DIR, `${event}.wav`);
  if (existsSync(cachePath)) {
    return require("node:fs").readFileSync(cachePath);
  }

  const spec = CUE_SPECS[event];
  if (!spec) throw new Error(`Unknown cue event: ${event}`);

  const wav = generateTone(spec);
  writeFileSync(cachePath, wav);
  return wav;
}

/** Play a cue sound (non-blocking) */
export function playCue(event: CueEvent): void {
  const wav = getCueAudio(event);
  const tmpFile = join(TMP_DIR, `cue_${randomBytes(4).toString("hex")}.wav`);
  writeFileSync(tmpFile, wav);

  const player = spawn("ffplay", [
    "-nodisp", "-autoexit", "-loglevel", "quiet", tmpFile,
  ], { stdio: "ignore", detached: true });

  player.on("close", () => {
    try { unlinkSync(tmpFile); } catch {}
  });
  player.on("error", () => {
    try { unlinkSync(tmpFile); } catch {}
  });
  player.unref();
}

/** Get all available cue events */
export function listCueEvents(): CueEvent[] {
  return Object.keys(CUE_SPECS) as CueEvent[];
}
