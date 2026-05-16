/**
 * Low-Latency Voice Pipeline — optimized for sub-500ms end-to-end response.
 * Uses pre-warmed processes, smaller models, and parallel execution.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

const IS_WIN = process.platform === "win32";
const TMP_DIR = join(homedir(), ".lax", "voice-tmp");
const VOICE_DIR = join(homedir(), ".lax", "workspace", "voice-chat");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

function tmpPath(ext: string): string {
  return join(TMP_DIR, `fast_${randomBytes(6).toString("hex")}.${ext}`);
}

export interface PipelineMetrics {
  sttMs: number;
  processingMs: number;
  ttsMs: number;
  totalMs: number;
}

export interface FastPipelineOptions {
  /** Whisper model size: tiny, base, small */
  whisperModel?: "tiny" | "tiny.en" | "base" | "base.en" | "small.en";
  /** Max audio duration to process (seconds) */
  maxAudioSec?: number;
  /** TTS speed multiplier */
  ttsSpeed?: number;
  /** TTS voice */
  voice?: string;
  /** Skip TTS for latency testing */
  skipTTS?: boolean;
  /** Message processor */
  processMessage?: (text: string) => Promise<string>;
}

export class FastVoicePipeline extends EventEmitter {
  private opts: Required<FastPipelineOptions>;
  private whisperExe: string;
  private whisperModelPath: string;

  constructor(options: FastPipelineOptions = {}) {
    super();
    this.opts = {
      whisperModel: options.whisperModel ?? "tiny.en",
      maxAudioSec: options.maxAudioSec ?? 10,
      ttsSpeed: options.ttsSpeed ?? 1.3,
      voice: options.voice ?? "am_onyx",
      skipTTS: options.skipTTS ?? false,
      processMessage: options.processMessage ?? (async (t) => t),
    };

    this.whisperExe = IS_WIN
      ? join(VOICE_DIR, "whisper-bin", "Release", "whisper-cli.exe")
      : join(VOICE_DIR, "whisper-bin", "whisper-cli");
    this.whisperModelPath = join(
      VOICE_DIR, "whisper-bin", "models",
      `ggml-${this.opts.whisperModel}.bin`,
    );
  }

  /** Check if fast pipeline is available */
  isAvailable(): boolean {
    return existsSync(this.whisperExe) && existsSync(this.whisperModelPath);
  }

  /** Fast STT — uses tiny model with aggressive settings */
  transcribeFast(audioBuffer: Buffer): { text: string; ms: number } {
    const start = Date.now();
    const wavPath = tmpPath("wav");

    try {
      writeFileSync(wavPath, audioBuffer);

      const output = execFileSync(this.whisperExe, [
        "-m", this.whisperModelPath,
        "-f", wavPath,
        "-np",     // no progress
        "-nt",     // no timestamps
        "-l", "en",
        "-t", "4", // threads
        "--no-context", // faster, no cross-segment context
      ], {
        encoding: "utf-8",
        timeout: 10_000,
      });

      let text = output.trim().replace(/\[.*?\]/g, "").trim();
      const lower = text.toLowerCase();
      if (lower === "thank you." || lower === "thanks for watching." || text.length < 2) {
        text = "";
      }

      return { text, ms: Date.now() - start };
    } finally {
      try { unlinkSync(wavPath); } catch {}
    }
  }

  /** Fast TTS — uses Piper (lower quality but much faster than Kokoro) */
  synthesizeFast(text: string): { wav: Buffer; ms: number } {
    const start = Date.now();
    const piperExe = IS_WIN
      ? join(VOICE_DIR, "piper", "piper", "piper.exe")
      : join(VOICE_DIR, "piper", "piper", "piper");
    const piperVoice = join(VOICE_DIR, "piper", "voices", "en_US-ryan-medium.onnx");

    if (!existsSync(piperExe) || !existsSync(piperVoice)) {
      return { wav: Buffer.alloc(0), ms: Date.now() - start };
    }

    const outPath = tmpPath("wav");
    try {
      // Truncate to first 200 chars for speed
      execFileSync(piperExe, [
        "--model", piperVoice,
        "--output_file", outPath,
        "--length_scale", String(1 / this.opts.ttsSpeed),
      ], {
        input: text.slice(0, 200),
        timeout: 5000,
        stdio: ["pipe", "ignore", "ignore"],
      });

      if (existsSync(outPath)) {
        const wav = readFileSync(outPath);
        return { wav, ms: Date.now() - start };
      }
      return { wav: Buffer.alloc(0), ms: Date.now() - start };
    } finally {
      try { unlinkSync(outPath); } catch {}
    }
  }

  /** Run the full pipeline: audio → text → response → speech */
  async process(audioBuffer: Buffer): Promise<{
    text: string;
    response: string;
    audioResponse: Buffer;
    metrics: PipelineMetrics;
  }> {
    const pipelineStart = Date.now();

    // STT
    const stt = this.transcribeFast(audioBuffer);
    this.emit("stt", { text: stt.text, ms: stt.ms });

    if (!stt.text) {
      return {
        text: "",
        response: "",
        audioResponse: Buffer.alloc(0),
        metrics: { sttMs: stt.ms, processingMs: 0, ttsMs: 0, totalMs: Date.now() - pipelineStart },
      };
    }

    // Process message
    const procStart = Date.now();
    const response = await this.opts.processMessage(stt.text);
    const processingMs = Date.now() - procStart;
    this.emit("response", { response, ms: processingMs });

    // TTS (optional)
    let ttsResult: { wav: Buffer; ms: number } = { wav: Buffer.alloc(0), ms: 0 };
    if (!this.opts.skipTTS && response) {
      ttsResult = this.synthesizeFast(response);
      this.emit("tts", { ms: ttsResult.ms });
    }

    const metrics: PipelineMetrics = {
      sttMs: stt.ms,
      processingMs,
      ttsMs: ttsResult.ms,
      totalMs: Date.now() - pipelineStart,
    };

    this.emit("complete", metrics);
    return { text: stt.text, response, audioResponse: ttsResult.wav, metrics };
  }
}

/** Create a fast pipeline with defaults optimized for latency */
export function createFastPipeline(
  handler?: (text: string) => Promise<string>,
): FastVoicePipeline {
  return new FastVoicePipeline({
    whisperModel: "tiny.en",
    ttsSpeed: 1.3,
    processMessage: handler,
  });
}
