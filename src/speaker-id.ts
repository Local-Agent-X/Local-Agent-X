/**
 * Speaker Identification — uses voice embeddings to identify who is speaking.
 * Extracts MFCC-based embeddings from audio and compares against enrolled speakers.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const SPEAKERS_DIR = join(homedir(), ".lax", "speakers");
const TMP_DIR = join(homedir(), ".lax", "voice-tmp");
if (!existsSync(SPEAKERS_DIR)) mkdirSync(SPEAKERS_DIR, { recursive: true });
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

function tmpPath(ext: string): string {
  return join(TMP_DIR, `spk_${randomBytes(6).toString("hex")}.${ext}`);
}

export interface SpeakerProfile {
  id: string;
  name: string;
  embedding: number[];
  enrolledAt: string;
}

export interface IdentifyResult {
  speakerId: string;
  speakerName: string;
  confidence: number;
}

/** Extract voice embedding from WAV audio using Python (librosa MFCC) */
export function extractEmbedding(audioBuffer: Buffer): number[] {
  const wavPath = tmpPath("wav");
  const outPath = tmpPath("json");
  const pyPath = tmpPath("py");

  const script = `
import sys, json, numpy as np
import librosa

audio, sr = librosa.load(sys.argv[1], sr=16000, mono=True)
mfcc = librosa.feature.mfcc(y=audio, sr=sr, n_mfcc=20)
# Average across time to get a fixed-length embedding
embedding = np.mean(mfcc, axis=1).tolist()
with open(sys.argv[2], 'w') as f:
    json.dump(embedding, f)
`.trim();

  try {
    writeFileSync(wavPath, audioBuffer);
    writeFileSync(pyPath, script, "utf-8");

    execFileSync("python", [pyPath, wavPath, outPath], {
      timeout: 15_000,
      stdio: "ignore",
    });

    if (existsSync(outPath)) {
      return JSON.parse(readFileSync(outPath, "utf-8"));
    }
    return [];
  } finally {
    try { require("node:fs").unlinkSync(wavPath); } catch {}
    try { require("node:fs").unlinkSync(pyPath); } catch {}
    try { require("node:fs").unlinkSync(outPath); } catch {}
  }
}

/** Cosine similarity between two vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Load all enrolled speaker profiles */
export function loadProfiles(): SpeakerProfile[] {
  const indexPath = join(SPEAKERS_DIR, "profiles.json");
  if (!existsSync(indexPath)) return [];
  return JSON.parse(readFileSync(indexPath, "utf-8"));
}

/** Save speaker profiles */
function saveProfiles(profiles: SpeakerProfile[]): void {
  const indexPath = join(SPEAKERS_DIR, "profiles.json");
  writeFileSync(indexPath, JSON.stringify(profiles, null, 2), "utf-8");
}

/** Enroll a new speaker from audio sample */
export function enrollSpeaker(name: string, audioBuffer: Buffer): SpeakerProfile {
  const embedding = extractEmbedding(audioBuffer);
  if (embedding.length === 0) throw new Error("Failed to extract voice embedding");

  const profile: SpeakerProfile = {
    id: randomBytes(8).toString("hex"),
    name,
    embedding,
    enrolledAt: new Date().toISOString(),
  };

  const profiles = loadProfiles();
  profiles.push(profile);
  saveProfiles(profiles);

  return profile;
}

/** Remove an enrolled speaker */
export function removeSpeaker(speakerId: string): boolean {
  const profiles = loadProfiles();
  const filtered = profiles.filter((p) => p.id !== speakerId);
  if (filtered.length === profiles.length) return false;
  saveProfiles(filtered);
  return true;
}

/** Identify speaker from audio — returns best match or null */
export function identifySpeaker(
  audioBuffer: Buffer,
  threshold = 0.85,
): IdentifyResult | null {
  const profiles = loadProfiles();
  if (profiles.length === 0) return null;

  const embedding = extractEmbedding(audioBuffer);
  if (embedding.length === 0) return null;

  let bestMatch: IdentifyResult | null = null;
  let bestScore = -1;

  for (const profile of profiles) {
    const score = cosineSimilarity(embedding, profile.embedding);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = {
        speakerId: profile.id,
        speakerName: profile.name,
        confidence: score,
      };
    }
  }

  if (bestMatch && bestMatch.confidence >= threshold) {
    return bestMatch;
  }
  return null;
}
