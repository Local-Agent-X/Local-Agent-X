/**
 * Streaming TTS — starts audio playback before full response completes.
 * Splits text into sentence chunks, synthesizes each independently,
 * and streams WAV data as chunks become ready.
 */

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

const TMP_DIR = join(getLaxDir(), "voice-tmp");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

const KOKORO_MODEL = join(getLaxDir(), "workspace", "voice-chat", "kokoro", "kokoro-v1.0.onnx");
const KOKORO_VOICES = join(getLaxDir(), "workspace", "voice-chat", "kokoro", "voices-v1.0.bin");

function tmpPath(ext: string): string {
  return join(TMP_DIR, `stream_${randomBytes(6).toString("hex")}.${ext}`);
}

/** Split text into speakable sentence chunks */
function splitSentences(text: string): string[] {
  const raw = text.match(/[^.!?]+[.!?]+[\s"]*/g) || [text];
  const sentences: string[] = [];
  let buffer = "";

  for (const s of raw) {
    buffer += s;
    // Flush when buffer has enough content (>40 chars or end)
    if (buffer.length >= 40) {
      sentences.push(buffer.trim());
      buffer = "";
    }
  }
  if (buffer.trim()) sentences.push(buffer.trim());
  return sentences.filter(Boolean);
}

export interface StreamChunk {
  index: number;
  wav: Buffer;
  text: string;
  latencyMs: number;
}

export class TTSStream extends EventEmitter {
  private cancelled = false;
  private voice: string;
  private speed: number;

  constructor(voice = "am_onyx", speed = 1.15) {
    super();
    this.voice = voice;
    this.speed = speed;
  }

  /** Cancel all pending synthesis */
  cancel(): void {
    this.cancelled = true;
    this.emit("cancelled");
  }

  /** Stream TTS for text — emits 'chunk' events as each sentence is ready */
  async stream(text: string): Promise<void> {
    const sentences = splitSentences(text);
    this.emit("start", { totalChunks: sentences.length });

    for (let i = 0; i < sentences.length; i++) {
      if (this.cancelled) break;

      const sentence = sentences[i];
      const start = Date.now();

      try {
        const wav = await this.synthesizeChunk(sentence);
        if (this.cancelled) break;

        const chunk: StreamChunk = {
          index: i,
          wav,
          text: sentence,
          latencyMs: Date.now() - start,
        };
        this.emit("chunk", chunk);
      } catch (err) {
        this.emit("error", { index: i, error: err });
      }
    }

    if (!this.cancelled) this.emit("done");
  }

  private synthesizeChunk(text: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const outPath = tmpPath("wav");
      const pyPath = tmpPath("py");

      const script = `
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

      writeFileSync(pyPath, script, "utf-8");

      const proc = spawn("python", [
        pyPath,
        text.replace(/"/g, "'"),
        this.voice,
        String(this.speed),
        outPath.replace(/\\/g, "/"),
      ], { stdio: ["ignore", "ignore", "ignore"] });

      proc.on("close", (code) => {
        try { unlinkSync(pyPath); } catch {}
        if (this.cancelled) {
          try { unlinkSync(outPath); } catch {}
          return reject(new Error("cancelled"));
        }
        if (code === 0 && existsSync(outPath)) {
          const wav = readFileSync(outPath);
          try { unlinkSync(outPath); } catch {}
          resolve(wav);
        } else {
          try { unlinkSync(outPath); } catch {}
          reject(new Error(`Kokoro exited with code ${code}`));
        }
      });

      proc.on("error", (err) => {
        try { unlinkSync(pyPath); } catch {}
        try { unlinkSync(outPath); } catch {}
        reject(err);
      });
    });
  }
}

/** Convenience: stream TTS and collect all WAV chunks */
export async function streamTTS(
  text: string,
  onChunk?: (chunk: StreamChunk) => void,
  voice?: string,
  speed?: number,
): Promise<Buffer[]> {
  const stream = new TTSStream(voice, speed);
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    stream.on("chunk", (chunk: StreamChunk) => {
      chunks.push(chunk.wav);
      onChunk?.(chunk);
    });
    stream.on("done", () => resolve(chunks));
    stream.on("error", reject);
    stream.stream(text).catch(reject);
  });
}
