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

const VOICE_DIR = join(homedir(), ".upstream", "workspace", "voice-chat");
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

// ── Feature 17: Continuous Listening with VAD ──

export interface ContinuousListenOptions {
  /** Silence duration (seconds) to split segments. Default: 1.5 */
  silenceThreshold?: number;
  /** Minimum segment duration (seconds) to transcribe. Default: 0.5 */
  minSegmentSec?: number;
  /** Maximum segment duration (seconds). Default: 30 */
  maxSegmentSec?: number;
  /** Callback for each transcribed segment */
  onTranscription?: (text: string, segmentIndex: number) => void;
  /** Callback for VAD state changes */
  onVADState?: (speaking: boolean) => void;
}

/**
 * Continuous listening with VAD-based auto-segmentation.
 * Records audio, splits on silence, transcribes each segment.
 * Returns a stop() function.
 */
export function continuousListen(options: ContinuousListenOptions = {}): { stop: () => void } {
  const silenceThreshold = options.silenceThreshold ?? 1.5;
  const minSeg = options.minSegmentSec ?? 0.5;
  const maxSeg = options.maxSegmentSec ?? 30;
  let running = true;
  let segmentIndex = 0;
  let currentProc: ReturnType<typeof spawn> | null = null;

  const loop = async () => {
    while (running) {
      const segPath = tmpPath("wav");
      try {
        // Record with silence detection via ffmpeg
        currentProc = spawn("ffmpeg", [
          "-f", "dshow", "-i", "audio=default",
          "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le",
          "-af", `silencedetect=noise=-30dB:d=${silenceThreshold}`,
          "-t", String(maxSeg),
          "-y", segPath,
        ], { stdio: ["ignore", "pipe", "pipe"] });

        const proc = currentProc;

        await new Promise<void>((resolve) => {
          let stderr = "";
          let speechDetected = false;

          proc.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
            if (!speechDetected && stderr.includes("silence_end")) {
              speechDetected = true;
              options.onVADState?.(true);
            }
            // End recording when silence follows speech
            if (speechDetected && stderr.lastIndexOf("silence_start") > stderr.lastIndexOf("silence_end")) {
              options.onVADState?.(false);
              setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} }, 200);
            }
          });

          proc.on("close", () => resolve());
          proc.on("error", () => resolve());
        });

        currentProc = null;
        if (!running) break;

        // Check file size (skip near-empty)
        if (existsSync(segPath)) {
          const stat = require("node:fs").statSync(segPath);
          const durationEstimate = (stat.size - 44) / (16000 * 2); // 16kHz 16-bit mono
          if (durationEstimate >= minSeg) {
            const audio = readFileSync(segPath);
            const text = transcribe(audio);
            if (text) {
              options.onTranscription?.(text, segmentIndex);
              segmentIndex++;
            }
          }
        }
      } catch {
        // Brief pause on error
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        try { unlinkSync(segPath); } catch {}
      }
    }
  };

  loop();

  return {
    stop() {
      running = false;
      if (currentProc) try { currentProc.kill(); } catch {}
    },
  };
}

// ── Feature 19: Voice Interruption ──

let _currentTTSProcess: ReturnType<typeof spawn> | null = null;
let _ttsInterrupted = false;

/** Register a TTS playback process so it can be interrupted */
export function registerTTSProcess(proc: ReturnType<typeof spawn>): void {
  _currentTTSProcess = proc;
  _ttsInterrupted = false;
  proc.on("close", () => {
    if (_currentTTSProcess === proc) _currentTTSProcess = null;
  });
}

/** Interrupt current TTS playback (call when new speech detected) */
export function interruptSpeech(): boolean {
  if (_currentTTSProcess) {
    _ttsInterrupted = true;
    try {
      _currentTTSProcess.kill();
      _currentTTSProcess = null;
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Check if TTS was interrupted */
export function wasTTSInterrupted(): boolean {
  return _ttsInterrupted;
}

// ── Feature 20: Whisper.cpp with Configurable Model ──

export type WhisperModel = "tiny" | "tiny.en" | "base" | "base.en" | "small" | "small.en" | "medium" | "medium.en" | "large";

/**
 * Transcribe audio using whisper-cli with configurable model size.
 * Falls back to default model if requested model not found.
 */
export function whisperTranscribe(
  audioBuffer: Buffer,
  options: {
    model?: WhisperModel;
    language?: string;
    translate?: boolean;
    threads?: number;
  } = {},
): string {
  const model = options.model ?? "base.en";
  const lang = options.language ?? "en";
  const threads = options.threads ?? 4;

  const modelPath = join(VOICE_DIR, "whisper-bin", "models", `ggml-${model}.bin`);
  const effectiveModel = existsSync(modelPath) ? modelPath : WHISPER_MODEL;

  if (!existsSync(WHISPER_EXE) || !existsSync(effectiveModel)) {
    return "";
  }

  const wavPath = tmpPath("wav");
  try {
    writeFileSync(wavPath, audioBuffer);

    const args = [
      "-m", effectiveModel,
      "-f", wavPath,
      "-np", "-nt",
      "-l", lang,
      "-t", String(threads),
    ];

    if (options.translate) args.push("--translate");

    const output = execFileSync(WHISPER_EXE, args, {
      encoding: "utf-8",
      timeout: 60_000,
    });

    let text = output.trim().replace(/\[.*?\]/g, "").trim();
    const lower = text.toLowerCase();
    if (lower === "thank you." || lower === "thanks for watching." || text.length < 2) {
      return "";
    }
    return text;
  } finally {
    try { unlinkSync(wavPath); } catch {}
  }
}

// ── Feature 26: Multi-Language STT/TTS ──

const LANGUAGE_WHISPER_MODELS: Record<string, string> = {
  en: "base.en",
  es: "base",
  fr: "base",
  de: "base",
  it: "base",
  pt: "base",
  ja: "base",
  ko: "base",
  zh: "base",
  ru: "base",
  ar: "base",
  hi: "base",
};

/**
 * Detect language from audio and transcribe with appropriate model.
 * Uses Whisper's built-in language detection on first pass,
 * then re-transcribes with language-specific settings.
 */
export function multiLanguageTranscribe(
  audioBuffer: Buffer,
): { text: string; language: string; confidence: number } {
  if (!existsSync(WHISPER_EXE)) {
    return { text: "", language: "unknown", confidence: 0 };
  }

  // Use multilingual model for language detection
  const multiModelPath = join(VOICE_DIR, "whisper-bin", "models", "ggml-base.bin");
  const detectModel = existsSync(multiModelPath) ? multiModelPath : WHISPER_MODEL;

  const wavPath = tmpPath("wav");
  try {
    writeFileSync(wavPath, audioBuffer);

    // First pass: detect language
    const detectOutput = execFileSync(WHISPER_EXE, [
      "-m", detectModel,
      "-f", wavPath,
      "-np", "-nt",
      "--detect-language",
    ], {
      encoding: "utf-8",
      timeout: 30_000,
    });

    // Parse detected language from output
    let detectedLang = "en";
    let confidence = 0;
    const langMatch = detectOutput.match(/language:\s*(\w+)\s*\(p\s*=\s*([\d.]+)\)/i);
    if (langMatch) {
      detectedLang = langMatch[1].toLowerCase();
      confidence = parseFloat(langMatch[2]);
    }

    // Second pass: transcribe with detected language
    const text = whisperTranscribe(audioBuffer, {
      model: (LANGUAGE_WHISPER_MODELS[detectedLang] || "base") as WhisperModel,
      language: detectedLang,
    });

    return { text, language: detectedLang, confidence };
  } finally {
    try { unlinkSync(wavPath); } catch {}
  }
}

// ── Feature 28: Bone Conduction / EQ Presets ──

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

/**
 * Apply an EQ preset to a WAV audio buffer using ffmpeg.
 * Returns the processed WAV buffer.
 */
export function applyEQPreset(audioBuffer: Buffer, preset: EQPreset = "default"): Buffer {
  if (preset === "default" || audioBuffer.length === 0) return audioBuffer;

  const eq = EQ_PRESETS[preset];
  if (!eq) return audioBuffer;

  const inPath = tmpPath("wav");
  const outPath = tmpPath("wav");

  // Build ffmpeg equalizer filter
  // bass ~100Hz, mid ~1kHz, treble ~8kHz
  const filters = [
    `equalizer=f=100:t=h:w=200:g=${eq.bass}`,
    `equalizer=f=1000:t=h:w=1000:g=${eq.mid}`,
    `equalizer=f=8000:t=h:w=4000:g=${eq.treble}`,
  ].join(",");

  try {
    writeFileSync(inPath, audioBuffer);
    execSync(`ffmpeg -i "${inPath}" -af "${filters}" -y "${outPath}"`, {
      timeout: 10_000,
      stdio: "ignore",
    });

    if (existsSync(outPath)) {
      return readFileSync(outPath);
    }
    return audioBuffer;
  } catch {
    return audioBuffer; // return original on failure
  } finally {
    try { unlinkSync(inPath); } catch {}
    try { unlinkSync(outPath); } catch {}
  }
}

/** List available EQ presets */
export function listEQPresets(): Array<{ name: EQPreset; description: string }> {
  return Object.entries(EQ_PRESETS).map(([name, eq]) => ({
    name: name as EQPreset,
    description: eq.description,
  }));
}
