import { execSync, execFileSync, spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Voice Engine — Local Whisper STT + Kokoro TTS
 *
 * Zero API calls. Everything runs on the local machine.
 *
 * STT: whisper.cpp (whisper-cli.exe) — accurate, fast, offline
 * TTS: Kokoro ONNX (via Python) — ChatGPT-quality voices, offline
 * Fallback TTS: Piper (if Kokoro unavailable) — good quality, instant
 */

// ── Paths ──

const VOICE_DIR = join(homedir(), ".openclaw", "workspace", "voice-chat");
const WHISPER_EXE = join(VOICE_DIR, "whisper-bin", "Release", "whisper-cli.exe");
const WHISPER_MODEL = join(VOICE_DIR, "whisper-bin", "models", "ggml-base.en.bin");
const PIPER_EXE = join(VOICE_DIR, "piper", "piper", "piper.exe");
const PIPER_VOICE = join(VOICE_DIR, "piper", "voices", "en_US-ryan-medium.onnx");
const KOKORO_MODEL = join(VOICE_DIR, "kokoro", "kokoro-v1.0.onnx");
const KOKORO_VOICES = join(VOICE_DIR, "kokoro", "voices-v1.0.bin");

// ── Temp dir for audio files ──

const TMP_DIR = join(homedir(), ".sax", "voice-tmp");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

function tmpPath(ext: string): string {
  return join(TMP_DIR, `${randomBytes(6).toString("hex")}.${ext}`);
}

// ── Capability detection ──

export interface VoiceCapabilities {
  stt: "whisper" | "none";
  tts: "kokoro" | "piper" | "xtts" | "none";
  whisperModel: string;
  ttsVoice: string;
  xttsAvailable: boolean;
}

export async function detectCapabilities(): Promise<VoiceCapabilities> {
  const stt = existsSync(WHISPER_EXE) && existsSync(WHISPER_MODEL) ? "whisper" as const : "none" as const;

  let tts: "kokoro" | "piper" | "none" = "none";
  let ttsVoice = "";

  // Check Kokoro (best quality)
  if (existsSync(KOKORO_MODEL) && existsSync(KOKORO_VOICES)) {
    try {
      execSync('python -c "from kokoro_onnx import Kokoro"', { timeout: 10000, stdio: "ignore" });
      tts = "kokoro";
      ttsVoice = "am_onyx";
    } catch {
      // Kokoro not available
    }
  }

  // Fallback: Piper
  if (tts === "none" && existsSync(PIPER_EXE) && existsSync(PIPER_VOICE)) {
    tts = "piper";
    ttsVoice = "en_US-ryan-medium";
  }

  // Check XTTS server availability
  let xttsAvailable = false;
  try {
    const r = await fetch("http://127.0.0.1:7862/health", { signal: AbortSignal.timeout(1000) });
    if (r.ok) xttsAvailable = true;
  } catch {}

  return {
    stt,
    tts,
    whisperModel: stt === "whisper" ? "base.en" : "",
    ttsVoice,
    xttsAvailable,
  };
}

// ── Text cleaning for TTS ──

function cleanForTTS(text: string): string {
  let clean = text;

  // Remove things that shouldn't be spoken
  clean = clean.replace(/```[\s\S]*?```/g, "");                  // code blocks — skip entirely
  clean = clean.replace(/`[^`]+`/g, "");                          // inline code
  clean = clean.replace(/https?:\/\/\S+/g, "");                  // URLs — don't read them
  clean = clean.replace(/[\w/\\.-]+\.(?:html|js|ts|css|json|md|py|sh)\b/g, ""); // file paths
  clean = clean.replace(/workspace\/\S+/g, "");                  // workspace paths
  clean = clean.replace(/\([^)]{15,}\)/g, "");                   // long parenthetical text (>15 chars)
  clean = clean.replace(/\{[^}]*\}/g, "");                        // JSON/code in braces
  clean = clean.replace(/\[.*?\]\(.*?\)/g, "");                  // markdown links
  clean = clean.replace(/\[\[.*?\]\]/g, "");                      // tags
  clean = clean.replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u23E9-\u23FA]+/gu, ""); // emojis
  clean = clean.replace(/[*_`#~>]/g, "");                        // markdown formatting
  clean = clean.replace(/[—–]/g, ", ");                            // dashes → pause
  clean = clean.replace(/\b\d{4,}\b/g, "");                       // long numbers (ports, IDs)
  clean = clean.replace(/[^\x20-\x7E]/g, "");                    // non-printable/non-ASCII
  clean = clean.replace(/\s{2,}/g, " ");                          // collapse whitespace
  clean = clean.replace(/^\s*[-•]\s*/gm, "");                    // bullet points
  clean = clean.replace(/^\s*\d+\.\s*/gm, "");                   // numbered lists (just the number)

  return clean.trim().slice(0, 2000);
}

// ── STT: Whisper ──

/**
 * Transcribe audio using local Whisper.
 * @param audioBuffer - WAV audio bytes
 * @returns Transcribed text
 */
export function transcribe(audioBuffer: Buffer): string {
  const wavPath = tmpPath("wav");

  try {
    writeFileSync(wavPath, audioBuffer);

    const output = execFileSync(WHISPER_EXE, [
      "-m", WHISPER_MODEL,
      "-f", wavPath,
      "-np",    // no progress
      "-nt",    // no timestamps
      "-l", "en",
    ], {
      encoding: "utf-8",
      timeout: 30_000,
    });

    // Clean up whisper output
    let text = output.trim();
    // Remove [special tokens] that whisper sometimes outputs
    text = text.replace(/\[.*?\]/g, "").trim();
    // Filter hallucinations
    const lower = text.toLowerCase();
    if (lower === "thank you." || lower === "thanks for watching." || text.length < 2) {
      return "";
    }

    // Voice injection guard: adversarial audio can make Whisper output prompt injection text.
    // Check transcription for injection patterns before returning.
    try {
      const { detectInjection } = require("./sanitize.js");
      const injections = detectInjection(text);
      if (injections.length > 0) {
        const maxScore = Math.max(...injections.map((i: { score: number }) => i.score));
        if (maxScore >= 0.7) {
          console.warn(`[voice] Injection detected in transcription (score=${maxScore.toFixed(2)}): "${text.slice(0, 80)}"`);
          return ""; // Silently drop injected transcription
        }
      }
    } catch {}

    return text;
  } finally {
    try { unlinkSync(wavPath); } catch {}
  }
}

// ── TTS: Kokoro (primary) ──

/**
 * Synthesize speech using Kokoro.
 * @param text - Text to speak
 * @param voice - Voice name (default: am_onyx)
 * @param speed - Speed multiplier (default: 0.95)
 * @returns WAV audio bytes
 */
export function synthesizeKokoro(
  text: string,
  voice: string = "am_onyx",
  speed: number = 1.15
): Buffer {
  const clean = cleanForTTS(text);
  if (!clean) return Buffer.alloc(0);

  const outPath = tmpPath("wav");

  try {
    // Run Kokoro via temp Python script (cmd.exe mangles inline Python)
    const pyScriptPath = tmpPath("py");
    const pyScript = `
import sys, wave, numpy as np
from kokoro_onnx import Kokoro
k = Kokoro('${KOKORO_MODEL.replace(/\\/g, "/")}', '${KOKORO_VOICES.replace(/\\/g, "/")}')
samples, sr = k.create(sys.argv[1], voice=sys.argv[2], speed=float(sys.argv[3]), lang='en-us')
with wave.open(sys.argv[4], 'wb') as f:
    f.setnchannels(1)
    f.setsampwidth(2)
    f.setframerate(sr)
    f.writeframes((samples * 32767).astype(np.int16).tobytes())
`.trim();

    writeFileSync(pyScriptPath, pyScript, "utf-8");
    try {
      execSync(
        `python "${pyScriptPath}" "${clean.replace(/"/g, '\\"')}" "${voice}" "${speed}" "${outPath.replace(/\\/g, "/")}"`,
        { timeout: 30_000, stdio: "ignore" }
      );
    } finally {
      try { unlinkSync(pyScriptPath); } catch {}
    }

    if (existsSync(outPath)) {
      return readFileSync(outPath);
    }
    return Buffer.alloc(0);
  } finally {
    try { unlinkSync(outPath); } catch {}
  }
}

// ── TTS: Piper (fallback) ──

/**
 * Synthesize speech using Piper.
 * @param text - Text to speak
 * @returns WAV audio bytes
 */
export function synthesizePiper(text: string): Buffer {
  const clean = cleanForTTS(text);
  if (!clean) return Buffer.alloc(0);

  const outPath = tmpPath("wav");

  try {
    const proc = spawn(PIPER_EXE, [
      "--model", PIPER_VOICE,
      "--output_file", outPath,
    ], { stdio: ["pipe", "ignore", "ignore"] });

    proc.stdin.write(clean);
    proc.stdin.end();

    // Wait synchronously (Piper is fast)
    execSync(`powershell -Command "Wait-Process -Id ${proc.pid} -Timeout 15"`, {
      timeout: 16_000,
      stdio: "ignore",
    });

    if (existsSync(outPath)) {
      return readFileSync(outPath);
    }
    return Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  } finally {
    try { unlinkSync(outPath); } catch {}
  }
}

// ── Unified synthesize function ──

/**
 * Synthesize text to speech using best available engine.
 */
export async function synthesize(
  text: string,
  voice?: string,
  speed?: number
): Promise<Buffer> {
  const caps = await detectCapabilities();

  if (caps.tts === "kokoro") {
    return synthesizeKokoro(text, voice || "am_onyx", speed || 0.95);
  }
  if (caps.tts === "piper") {
    return synthesizePiper(text);
  }
  return Buffer.alloc(0);
}
