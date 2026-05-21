// Continuous listening with VAD-based auto-segmentation. Records audio
// via ffmpeg, splits on silence using `silencedetect`, transcribes each
// segment, fires onTranscription per segment.
//
// ffmpeg audio input format is per-platform: dshow on Windows,
// avfoundation on macOS (:0 = default mic), alsa on Linux.

import { spawn } from "node:child_process";
import { readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { tmpPath } from "./paths.js";
import { transcribe } from "./stt.js";

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
        const audioInput: [string, string] = process.platform === "win32"
          ? ["dshow", "audio=default"]
          : process.platform === "darwin"
            ? ["avfoundation", ":0"]
            : ["alsa", "default"];
        currentProc = spawn("ffmpeg", [
          "-f", audioInput[0], "-i", audioInput[1],
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

        if (existsSync(segPath)) {
          const stat = statSync(segPath);
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
