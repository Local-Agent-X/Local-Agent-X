/**
 * Audio-Only Agent — runs the full agent loop via voice only (no UI needed).
 * Listens for speech, transcribes, sends to agent, speaks response, repeat.
 */

import { spawn, ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

const TMP_DIR = join(getLaxDir(), "voice-tmp");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

function tmpPath(ext: string): string {
  return join(TMP_DIR, `agent_${randomBytes(6).toString("hex")}.${ext}`);
}

export interface AudioAgentOptions {
  /** Function that takes user text and returns agent response */
  processMessage: (text: string) => Promise<string>;
  /** Voice for TTS */
  voice?: string;
  /** Silence threshold in seconds before finalizing recording */
  silenceTimeout?: number;
  /** Wake word required before each command */
  requireWakeWord?: boolean;
  /** Callback for status updates */
  onStatus?: (status: string) => void;
}

type AgentState = "idle" | "listening" | "processing" | "speaking";

export class AudioAgent extends EventEmitter {
  private state: AgentState = "idle";
  private options: Required<AudioAgentOptions>;
  private running = false;
  private recorder: ChildProcess | null = null;
  private currentTTS: ChildProcess | null = null;

  constructor(opts: AudioAgentOptions) {
    super();
    this.options = {
      processMessage: opts.processMessage,
      voice: opts.voice ?? "am_onyx",
      silenceTimeout: opts.silenceTimeout ?? 2,
      requireWakeWord: opts.requireWakeWord ?? false,
      onStatus: opts.onStatus ?? (() => {}),
    };
  }

  get currentState(): AgentState {
    return this.state;
  }

  /** Start the voice agent loop */
  async start(): Promise<void> {
    this.running = true;
    this.setState("idle");
    this.options.onStatus("Audio agent started — listening for speech");

    while (this.running) {
      try {
        // Record audio until silence
        this.setState("listening");
        const audio = await this.recordUntilSilence();
        if (!this.running || !audio) continue;

        // Transcribe
        const { transcribe } = await import("./voice.js");
        const text = transcribe(audio);
        if (!text || text.length < 2) {
          this.options.onStatus("No speech detected, listening again...");
          continue;
        }

        this.emit("transcription", text);
        this.options.onStatus(`Heard: "${text}"`);

        // Process through agent
        this.setState("processing");
        const response = await this.options.processMessage(text);
        if (!this.running) break;

        this.emit("response", response);

        // Speak response
        this.setState("speaking");
        await this.speak(response);

        this.setState("idle");
      } catch (err) {
        this.emit("error", err);
        this.options.onStatus(`Error: ${err}`);
        // Brief pause before retrying
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** Stop the agent loop */
  stop(): void {
    this.running = false;
    this.killRecorder();
    this.killTTS();
    this.setState("idle");
    this.options.onStatus("Audio agent stopped");
  }

  /** Interrupt current speech and go back to listening */
  interrupt(): void {
    this.killTTS();
    this.setState("idle");
  }

  private setState(s: AgentState): void {
    this.state = s;
    this.emit("state", s);
  }

  private killRecorder(): void {
    if (this.recorder) {
      try { this.recorder.kill(); } catch {}
      this.recorder = null;
    }
  }

  private killTTS(): void {
    if (this.currentTTS) {
      try { this.currentTTS.kill(); } catch {}
      this.currentTTS = null;
    }
  }

  /** Record from microphone until silence detected */
  private recordUntilSilence(): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const outPath = tmpPath("wav");
      const timeout = this.options.silenceTimeout;

      // Use ffmpeg to record from default audio device with silence detection
      const proc = spawn("ffmpeg", [
        "-f", "dshow",
        "-i", "audio=default",
        "-ar", "16000",
        "-ac", "1",
        "-acodec", "pcm_s16le",
        "-af", `silencedetect=noise=-30dB:d=${timeout}`,
        "-t", "30", // max 30 seconds
        "-y", outPath,
      ], { stdio: ["ignore", "pipe", "pipe"] });

      this.recorder = proc;
      let stderrData = "";

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrData += chunk.toString();
        // Check if silence was detected after speech
        if (stderrData.includes("silence_end") && stderrData.includes("silence_start")) {
          setTimeout(() => {
            try { proc.kill("SIGTERM"); } catch {}
          }, 200);
        }
      });

      proc.on("close", () => {
        this.recorder = null;
        if (existsSync(outPath)) {
          const buf = readFileSync(outPath);
          try { unlinkSync(outPath); } catch {}
          resolve(buf.length > 1000 ? buf : null); // skip near-empty recordings
        } else {
          resolve(null);
        }
      });

      proc.on("error", () => {
        this.recorder = null;
        resolve(null);
      });
    });
  }

  /** Speak text using TTS */
  private async speak(text: string): Promise<void> {
    const { synthesize } = await import("./voice.js");
    const wav = await synthesize(text, this.options.voice);
    if (!wav || wav.length === 0 || !this.running) return;

    return new Promise((resolve) => {
      const wavPath = tmpPath("wav");
      writeFileSync(wavPath, wav);

      const proc = spawn("ffplay", [
        "-nodisp", "-autoexit", "-loglevel", "quiet", wavPath,
      ], { stdio: "ignore" });

      this.currentTTS = proc;

      proc.on("close", () => {
        this.currentTTS = null;
        try { unlinkSync(wavPath); } catch {}
        resolve();
      });

      proc.on("error", () => {
        this.currentTTS = null;
        try { unlinkSync(wavPath); } catch {}
        resolve();
      });
    });
  }
}

/** Quick-start an audio agent with a simple message handler */
export function createAudioAgent(
  handler: (text: string) => Promise<string>,
  options?: Partial<AudioAgentOptions>,
): AudioAgent {
  return new AudioAgent({ processMessage: handler, ...options });
}
