// EQ presets applied via ffmpeg. Bone-conduction boost compensates for the
// frequency response loss when audio goes through the skull; hearing-aid
// preset emphasizes the speech-band mids/treble. Other presets target
// playback medium (headphones vs phone earpiece vs small speaker).

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpPath } from "./paths.js";

export type EQPreset = "default" | "bone_conduction" | "hearing_aid" | "headphones" | "speaker" | "phone" | "bright" | "warm";

const EQ_PRESETS: Record<EQPreset, { bass: number; mid: number; treble: number; description: string }> = {
  default:          { bass: 0, mid: 0, treble: 0, description: "Flat EQ — no adjustments" },
  bone_conduction:  { bass: 6, mid: 3, treble: -2, description: "Boosted bass to compensate for bone conduction loss" },
  hearing_aid:      { bass: 2, mid: 4, treble: 6, description: "Enhanced clarity for hearing-impaired listeners" },
  headphones:       { bass: 2, mid: 0, treble: 1, description: "Slight bass boost for headphone listening" },
  speaker:          { bass: -2, mid: 2, treble: 0, description: "Reduced bass, boosted mids for small speakers" },
  phone:            { bass: -3, mid: 4, treble: 2, description: "Optimized for phone earpiece" },
  bright:           { bass: -2, mid: 0, treble: 4, description: "Bright, clear sound" },
  warm:             { bass: 4, mid: 1, treble: -2, description: "Warm, rich sound" },
};

export function applyEQPreset(audioBuffer: Buffer, preset: EQPreset = "default"): Buffer {
  if (preset === "default" || audioBuffer.length === 0) return audioBuffer;
  const eq = EQ_PRESETS[preset];
  if (!eq) return audioBuffer;

  const inPath = tmpPath("wav");
  const outPath = tmpPath("wav");

  // bass ~100Hz, mid ~1kHz, treble ~8kHz
  const filters = [
    `equalizer=f=100:t=h:w=200:g=${eq.bass}`,
    `equalizer=f=1000:t=h:w=1000:g=${eq.mid}`,
    `equalizer=f=8000:t=h:w=4000:g=${eq.treble}`,
  ].join(",");

  try {
    writeFileSync(inPath, audioBuffer);
    execFileSync("ffmpeg", ["-i", inPath, "-af", filters, "-y", outPath], {
      timeout: 10_000, stdio: "ignore",
    });
    if (existsSync(outPath)) return readFileSync(outPath);
    return audioBuffer;
  } catch {
    return audioBuffer;
  } finally {
    try { unlinkSync(inPath); } catch {}
    try { unlinkSync(outPath); } catch {}
  }
}

export function listEQPresets(): Array<{ name: EQPreset; description: string }> {
  return Object.entries(EQ_PRESETS).map(([name, eq]) => ({
    name: name as EQPreset,
    description: eq.description,
  }));
}
