/**
 * Voice Authentication — voiceprint matching to verify speaker identity.
 * Uses MFCC-based embeddings with cosine similarity scoring.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";

const verifyAttempts = new Map<string, number[]>();
const VERIFY_MAX_ATTEMPTS = 5;
const VERIFY_WINDOW_MS = 60_000;

const AUTH_DIR = join(homedir(), ".lax", "voice-auth");
const TMP_DIR = join(homedir(), ".lax", "voice-tmp");
if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

function tmpPath(ext: string): string {
  return join(TMP_DIR, `auth_${randomBytes(6).toString("hex")}.${ext}`);
}

export interface Voiceprint {
  userId: string;
  label: string;
  embeddings: number[][];  // multiple enrollment samples for robustness
  createdAt: string;
  lastVerified?: string;
}

export interface AuthResult {
  authenticated: boolean;
  userId: string;
  label: string;
  confidence: number;
  threshold: number;
}

/** Extract multiple embeddings from a single audio sample (windowed) */
function extractEmbeddings(audioBuffer: Buffer): number[][] {
  const wavPath = tmpPath("wav");
  const outPath = tmpPath("json");
  const pyPath = tmpPath("py");

  const script = `
import sys, json, numpy as np
import librosa

audio, sr = librosa.load(sys.argv[1], sr=16000, mono=True)
duration = len(audio) / sr

# Extract overlapping windows for multiple embeddings
window_sec = min(3.0, duration)
hop_sec = max(1.0, window_sec / 2)
window_samples = int(window_sec * sr)
hop_samples = int(hop_sec * sr)

embeddings = []
pos = 0
while pos + window_samples <= len(audio):
    segment = audio[pos:pos + window_samples]
    mfcc = librosa.feature.mfcc(y=segment, sr=sr, n_mfcc=20)
    delta = librosa.feature.delta(mfcc)
    # Combine MFCC + delta for richer embedding
    combined = np.concatenate([np.mean(mfcc, axis=1), np.std(mfcc, axis=1), np.mean(delta, axis=1)])
    embeddings.append(combined.tolist())
    pos += hop_samples

# If audio too short, just do one embedding
if not embeddings and len(audio) > sr * 0.5:
    mfcc = librosa.feature.mfcc(y=audio, sr=sr, n_mfcc=20)
    delta = librosa.feature.delta(mfcc)
    combined = np.concatenate([np.mean(mfcc, axis=1), np.std(mfcc, axis=1), np.mean(delta, axis=1)])
    embeddings.append(combined.tolist())

with open(sys.argv[2], 'w') as f:
    json.dump(embeddings, f)
`.trim();

  try {
    writeFileSync(wavPath, audioBuffer);
    writeFileSync(pyPath, script, "utf-8");
    execFileSync("python", [pyPath, wavPath, outPath], { timeout: 15_000, stdio: "ignore" });

    if (existsSync(outPath)) {
      return JSON.parse(readFileSync(outPath, "utf-8"));
    }
    return [];
  } finally {
    try { unlinkSync(wavPath); } catch {}
    try { unlinkSync(pyPath); } catch {}
    try { unlinkSync(outPath); } catch {}
  }
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, mA = 0, mB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    mA += a[i] * a[i];
    mB += b[i] * b[i];
  }
  const d = Math.sqrt(mA) * Math.sqrt(mB);
  return d === 0 ? 0 : dot / d;
}

function loadVoiceprints(): Voiceprint[] {
  const path = join(AUTH_DIR, "voiceprints.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf-8"));
}

function saveVoiceprints(vps: Voiceprint[]): void {
  writeFileSync(join(AUTH_DIR, "voiceprints.json"), JSON.stringify(vps, null, 2), "utf-8");
}

/** Enroll a user's voiceprint from audio samples */
export function enroll(userId: string, label: string, audioBuffers: Buffer[]): Voiceprint {
  const allEmbeddings: number[][] = [];

  for (const buf of audioBuffers) {
    const embs = extractEmbeddings(buf);
    allEmbeddings.push(...embs);
  }

  if (allEmbeddings.length === 0) {
    throw new Error("Failed to extract voice embeddings from audio samples");
  }

  const voiceprint: Voiceprint = {
    userId,
    label,
    embeddings: allEmbeddings,
    createdAt: new Date().toISOString(),
  };

  const vps = loadVoiceprints().filter((v) => v.userId !== userId);
  vps.push(voiceprint);
  saveVoiceprints(vps);

  return voiceprint;
}

/** Verify a speaker against an enrolled voiceprint */
export function verify(
  userId: string,
  audioBuffer: Buffer,
  threshold = 0.82,
): AuthResult {
  const now = Date.now();
  const attempts = verifyAttempts.get(userId) || [];
  const recentAttempts = attempts.filter(t => now - t < VERIFY_WINDOW_MS);
  if (recentAttempts.length >= VERIFY_MAX_ATTEMPTS) {
    return { authenticated: false, userId, label: "", confidence: 0, threshold };
  }
  recentAttempts.push(now);
  verifyAttempts.set(userId, recentAttempts);

  const vps = loadVoiceprints();
  const vp = vps.find((v) => v.userId === userId);

  if (!vp) {
    return { authenticated: false, userId, label: "", confidence: 0, threshold };
  }

  const testEmbeddings = extractEmbeddings(audioBuffer);
  if (testEmbeddings.length === 0) {
    return { authenticated: false, userId, label: vp.label, confidence: 0, threshold };
  }

  // Compare each test embedding against all enrolled embeddings, take best average
  let maxAvg = 0;
  for (const test of testEmbeddings) {
    const scores = vp.embeddings.map((enrolled) => cosineSim(test, enrolled));
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg > maxAvg) maxAvg = avg;
  }

  const authenticated = maxAvg >= threshold;

  if (authenticated) {
    // Update last verified time
    vp.lastVerified = new Date().toISOString();
    saveVoiceprints(vps);
  }

  return { authenticated, userId, label: vp.label, confidence: maxAvg, threshold };
}

/** Identify who is speaking (without knowing userId in advance) */
export function identify(
  audioBuffer: Buffer,
  threshold = 0.82,
): AuthResult | null {
  const vps = loadVoiceprints();
  if (vps.length === 0) return null;

  const testEmbeddings = extractEmbeddings(audioBuffer);
  if (testEmbeddings.length === 0) return null;

  let bestResult: AuthResult | null = null;
  let bestScore = 0;

  for (const vp of vps) {
    for (const test of testEmbeddings) {
      const scores = vp.embeddings.map((enrolled) => cosineSim(test, enrolled));
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (avg > bestScore) {
        bestScore = avg;
        bestResult = {
          authenticated: avg >= threshold,
          userId: vp.userId,
          label: vp.label,
          confidence: avg,
          threshold,
        };
      }
    }
  }

  return bestResult;
}

/** Remove a user's voiceprint */
export function unenroll(userId: string): boolean {
  const vps = loadVoiceprints();
  const filtered = vps.filter((v) => v.userId !== userId);
  if (filtered.length === vps.length) return false;
  saveVoiceprints(filtered);
  return true;
}

/** List enrolled users */
export function listEnrolled(): Array<{ userId: string; label: string; createdAt: string }> {
  return loadVoiceprints().map((v) => ({
    userId: v.userId,
    label: v.label,
    createdAt: v.createdAt,
  }));
}
