/**
 * The transcription job's own process: one recording turned into timestamped
 * text, apart from the server so a 30-minute file neither freezes LAX nor dies
 * at a tool's time limit (transcription-job.ts starts it, hidden, and reads
 * what it writes).
 *
 * ffmpeg streams the audio once as 16 kHz mono PCM; every WINDOW_SEC of it is
 * recognized and appended to the job file as one line, so a job stopped
 * halfway keeps what it finished and the next one starts after it. The
 * recognizer is sherpa-onnx's native addon on several cores; where that build
 * will not load, the WASM build every install already has (one core, slower,
 * still off the server's thread).
 */

import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { buildConfig, createWhisperTranscriber } from "../voice/whisper-stream.js";
import type { WhisperModelPaths } from "../voice/whisper-model-fetch.js";

const requireCJS = createRequire(import.meta.url);

export const WINDOW_SEC = 30;
const RATE = 16_000;

/** What the server hands the child, as its one argument (JSON). */
export interface ChildJob {
  input: string;
  ffmpeg: string;
  /** First second to transcribe, and how many seconds after it (0 = to the end). */
  startSec: number;
  spanSec: number;
  out: string;
  model: WhisperModelPaths;
  threads: number;
}

/** One line of the job file. */
export type JobLine =
  | { t: "engine"; native: boolean; threads: number }
  | { t: "seg"; start: number; end: number; text: string }
  | { t: "done"; end: number }
  | { t: "error"; message: string };

interface NativeStream { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void }
interface NativeRecognizer {
  createStream(): NativeStream;
  decode(s: NativeStream): void;
  getResult(s: NativeStream): { text?: string };
}

type Recognize = (samples: Int16Array) => Promise<string>;

function nativeRecognizer(job: ChildJob): Recognize {
  const sherpa = requireCJS("sherpa-onnx-node") as { OfflineRecognizer: new (c: unknown) => NativeRecognizer };
  const config = { featConfig: { sampleRate: RATE, featureDim: 80 }, ...(buildConfig(job.model, "cpu", job.threads) as object) };
  const rec = new sherpa.OfflineRecognizer(config);
  return async (pcm) => {
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate: RATE, samples });
    rec.decode(stream);
    return (rec.getResult(stream).text ?? "").trim();
  };
}

/** The native addon, or the WASM build when it will not load here. */
export function openRecognizer(job: ChildJob, loadNative = nativeRecognizer): { recognize: Recognize; native: boolean } {
  try {
    return { recognize: loadNative(job), native: true };
  } catch {
    const wasm = createWhisperTranscriber(job.model);
    return { recognize: (pcm) => wasm.transcribe(pcm), native: false };
  }
}

function write(out: string, line: JobLine): void {
  appendFileSync(out, `${JSON.stringify(line)}\n`);
}

/** Leave when the server that started the job is gone, rather than burn the
 *  CPU for nobody; the next job resumes from the file. */
function exitWithParent(): void {
  const parent = process.ppid;
  setInterval(() => {
    try { process.kill(parent, 0); } catch { process.exit(0); }
  }, 5_000).unref();
}

async function run(job: ChildJob): Promise<void> {
  const { recognize, native } = openRecognizer(job);
  write(job.out, { t: "engine", native, threads: native ? job.threads : 1 });
  const args = ["-v", "error", "-ss", String(job.startSec), ...(job.spanSec > 0 ? ["-t", String(job.spanSec)] : []),
    "-i", job.input, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "pipe:1"];
  const ff = spawn(job.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  ff.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const windowBytes = WINDOW_SEC * RATE * 2;
  let pending: Buffer = Buffer.alloc(0);
  let cursor = job.startSec;
  const flush = async (bytes: Buffer) => {
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
    const sec = pcm.length / RATE;
    const text = pcm.length >= 1600 ? await recognize(pcm) : "";
    write(job.out, { t: "seg", start: cursor, end: cursor + sec, text });
    cursor += sec;
  };
  // Pausing the pipe while a window is recognized keeps memory at one window,
  // however long the recording.
  for await (const chunk of ff.stdout as AsyncIterable<Buffer>) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= windowBytes) {
      await flush(Buffer.from(pending.subarray(0, windowBytes)));
      pending = pending.subarray(windowBytes);
    }
  }
  const code: number | null = ff.exitCode ?? await new Promise((r) => ff.once("close", r));
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 300)}`);
  if (pending.length > 0) await flush(Buffer.from(pending));
  write(job.out, { t: "done", end: cursor });
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "\0");
if (isEntry && process.argv[2]) {
  const job = JSON.parse(process.argv[2]) as ChildJob;
  exitWithParent();
  run(job).then(
    () => process.exit(0),
    (e) => { try { write(job.out, { t: "error", message: (e as Error).message }); } catch { /* the file is gone */ } process.exit(1); },
  );
}
