/**
 * The transcription job's own process: one recording turned into timestamped
 * text, apart from the server so a 30-minute file neither freezes LAX nor dies
 * at a tool's time limit (transcription-job.ts starts it, hidden, and reads
 * what it writes).
 *
 * ffmpeg streams the audio once as 16 kHz mono PCM. Silero VAD cuts it at
 * pauses into utterances, each recognized on its own and appended to the job
 * file as one line, so a job stopped halfway keeps what it finished and the
 * next one starts after it. The recognizer is sherpa-onnx's native addon on
 * several cores; where that build will not load, the WASM build every install
 * already has (one core, fixed slices, slower, still off the server's thread).
 */

import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { buildConfig, createWhisperTranscriber } from "../voice/whisper-stream.js";
import type { WhisperModelPaths } from "../voice/whisper-model-fetch.js";

const requireCJS = createRequire(import.meta.url);

/** Longest piece the recognizer gets: Whisper reads at most 30 s at a time. */
export const MAX_PIECE_SEC = 25;
/** Fixed slices, where no speech detector is to hand. */
export const WINDOW_SEC = 25;
const RATE = 16_000;
/** Silence either side of an utterance keeps its first and last syllables. */
const PAD = RATE / 4;

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
  /** Silero VAD model: cut at pauses rather than at fixed slices. */
  vadModel?: string;
}

/** One line of the job file. A `seg` covers start..end with no gap from the
 *  one before; `at` is where its speech begins, for the timestamp. */
export type JobLine =
  | { t: "engine"; native: boolean; threads: number; pauses?: boolean }
  | { t: "seg"; start: number; end: number; at?: number; text: string }
  | { t: "done"; end: number }
  | { t: "error"; message: string };

/** A stretch of audio to recognize, by its first sample in the stream. */
export interface Piece { first: number; samples: Float32Array }

/** Cuts the stream into pieces as it arrives. */
export interface Cutter { push(samples: Float32Array): Piece[]; end(): Piece[] }

interface NativeStream { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void }
interface NativeRecognizer {
  createStream(): NativeStream;
  decode(s: NativeStream): void;
  getResult(s: NativeStream): { text?: string; lang?: string };
  setConfig(c: unknown): void;
}
export interface NativeVad {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  front(): { start: number; samples: Float32Array };
  pop(): void;
  flush(): void;
}
export interface NativeModule {
  OfflineRecognizer: new (c: unknown) => NativeRecognizer;
  Vad: new (c: unknown, bufferSec: number) => NativeVad;
}

export type Recognize = (samples: Float32Array) => Promise<string>;

/** A recording can be in any language: the multilingual model detects it
 *  ("" to Whisper). A Spanish meeting came back word-perfect (2026-11-18). */
const RECORDING_LANGUAGE = "";

/** Detecting the language piece by piece, a short burst of crosstalk in an
 *  English call came back as French ("Et à Olax 1208", 2026-11-18). So the
 *  recording's language is told once, from its first stretch of speech, and
 *  every piece is transcribed in it (languageGate). */
export interface LanguageLock {
  /** The language this speech is in, by the model's own detection. */
  detect(samples: Float32Array): string | undefined;
  /** Transcribe everything from here on in `language`. */
  hold(language: string): void;
}

function nativeRecognizer(job: ChildJob, sherpa: NativeModule): { recognize: Recognize; language?: LanguageLock } {
  const config = (language: string) => ({
    featConfig: { sampleRate: RATE, featureDim: 80 }, ...(buildConfig(job.model, "cpu", job.threads, language) as object),
  });
  const rec = new sherpa.OfflineRecognizer(config(RECORDING_LANGUAGE));
  const decode = (samples: Float32Array) => {
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate: RATE, samples });
    rec.decode(stream);
    return rec.getResult(stream);
  };
  const recognize: Recognize = async (samples) => (decode(samples).text ?? "").trim();
  if (job.model.kind === "nemo_transducer") return { recognize };
  return {
    recognize,
    // setConfig changes the language without loading the model again.
    language: { detect: (samples) => decode(samples).lang || undefined, hold: (lang) => rec.setConfig(config(lang)) },
  };
}

/** How much speech tells the language: what Whisper itself reads to detect it,
 *  less the padding pieceWriter adds. */
export const LANGUAGE_SAMPLE_SEC = 25;

/** Holds the first pieces until there is LANGUAGE_SAMPLE_SEC of speech (or the
 *  recording ends), tells their language, holds the recognizer to it, then
 *  writes them in order; later pieces pass straight through. */
export function languageGate(lock: LanguageLock | undefined, write: (p: Piece) => Promise<void>) {
  let held: Piece[] | null = lock ? [] : null;
  let heldSamples = 0;
  const release = async () => {
    const pieces = held ?? [];
    held = null;
    if (pieces.length) {
      const speech = new Float32Array(Math.min(heldSamples, LANGUAGE_SAMPLE_SEC * RATE));
      let at = 0;
      for (const p of pieces) {
        const n = Math.min(p.samples.length, speech.length - at);
        speech.set(p.samples.subarray(0, n), at);
        at += n;
      }
      const language = lock!.detect(speech);
      if (language) lock!.hold(language);
    }
    for (const p of pieces) await write(p);
  };
  return {
    async write(piece: Piece): Promise<void> {
      if (!held) return write(piece);
      held.push(piece);
      heldSamples += piece.samples.length;
      if (heldSamples >= LANGUAGE_SAMPLE_SEC * RATE) await release();
    },
    async end(): Promise<void> { if (held) await release(); },
  };
}

/** The native addon, or the WASM build when it will not load here. */
export function openRecognizer(
  job: ChildJob,
  loadNative: () => NativeModule = () => requireCJS("sherpa-onnx-node") as NativeModule,
): { recognize: Recognize; native: boolean; sherpa?: NativeModule; language?: LanguageLock } {
  try {
    const sherpa = loadNative();
    return { ...nativeRecognizer(job, sherpa), native: true, sherpa };
  } catch {
    const wasm = createWhisperTranscriber(job.model, { language: RECORDING_LANGUAGE });
    return {
      recognize: (samples) => {
        const pcm = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 0x7fff;
        return wasm.transcribe(pcm);
      },
      native: false,
    };
  }
}

/** Fixed slices of `windowSec`. */
export function windowCutter(windowSec = WINDOW_SEC): Cutter {
  const size = windowSec * RATE;
  let held = new Float32Array(0);
  let first = 0;
  const take = (all: boolean): Piece[] => {
    const out: Piece[] = [];
    while (held.length >= size || (all && held.length > 0)) {
      const n = Math.min(size, held.length);
      out.push({ first, samples: held.slice(0, n) });
      held = held.slice(n);
      first += n;
    }
    return out;
  };
  return {
    push(samples) {
      const next = new Float32Array(held.length + samples.length);
      next.set(held);
      next.set(samples, held.length);
      held = next;
      return take(false);
    },
    end() { return take(true); },
  };
}

/** One utterance per piece, cut at pauses by Silero VAD and never longer than
 *  MAX_PIECE_SEC. Fixed 30 s slices of a two-person call lost whole passages:
 *  of a 3-minute stretch holding about 400 words, Parakeet on slices heard 253
 *  and Whisper small.en cut at pauses heard 406 (2026-11-17). */
export function pauseCutter(vad: NativeVad): Cutter {
  const FRAME = 512;
  let carry = new Float32Array(0);
  const drain = (): Piece[] => {
    const out: Piece[] = [];
    while (!vad.isEmpty()) {
      const seg = vad.front();
      out.push({ first: seg.start, samples: seg.samples });
      vad.pop();
    }
    return out;
  };
  return {
    push(samples) {
      const all = new Float32Array(carry.length + samples.length);
      all.set(carry);
      all.set(samples, carry.length);
      const whole = all.length - (all.length % FRAME);
      for (let i = 0; i < whole; i += FRAME) vad.acceptWaveform(all.subarray(i, i + FRAME));
      carry = all.slice(whole);
      return drain();
    },
    end() {
      if (carry.length) vad.acceptWaveform(carry);
      vad.flush();
      return drain();
    },
  };
}

function nativeVad(sherpa: NativeModule, model: string): NativeVad {
  return new sherpa.Vad({
    sileroVad: { model, threshold: 0.3, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: MAX_PIECE_SEC, windowSize: 512 },
    sampleRate: RATE, numThreads: 1, debug: false,
  }, 120);
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

/** Recognize each piece and write it as a line covering the stretch since the
 *  last one, so the job file stays an unbroken record of what is done. */
export function pieceWriter(job: ChildJob, recognize: Recognize, emit: (line: JobLine) => void) {
  let cursor = job.startSec;
  return {
    async write(piece: Piece): Promise<void> {
      const at = job.startSec + piece.first / RATE;
      const end = at + piece.samples.length / RATE;
      const padded = new Float32Array(piece.samples.length + 2 * PAD);
      padded.set(piece.samples, PAD);
      const text = piece.samples.length >= 1600 ? await recognize(padded) : "";
      emit({ t: "seg", start: cursor, end, at, text });
      cursor = end;
    },
    finish(totalSamples: number): void {
      const end = job.startSec + totalSamples / RATE;
      if (end > cursor) emit({ t: "seg", start: cursor, end, text: "" });
      emit({ t: "done", end: Math.max(end, cursor) });
    },
  };
}

async function run(job: ChildJob): Promise<void> {
  const { recognize, native, sherpa, language } = openRecognizer(job);
  const pauses = Boolean(sherpa && job.vadModel);
  write(job.out, { t: "engine", native, threads: native ? job.threads : 1, pauses });
  const cutter = sherpa && job.vadModel ? pauseCutter(nativeVad(sherpa, job.vadModel)) : windowCutter();
  const writer = pieceWriter(job, recognize, (line) => write(job.out, line));
  const gate = languageGate(language, (p) => writer.write(p));
  const out = { write: gate.write, finish: async (total: number) => { await gate.end(); writer.finish(total); } };
  const args = ["-v", "error", "-ss", String(job.startSec), ...(job.spanSec > 0 ? ["-t", String(job.spanSec)] : []),
    "-i", job.input, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "pipe:1"];
  const ff = spawn(job.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  ff.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  let odd: Buffer = Buffer.alloc(0);
  let total = 0;
  // Recognizing inside the loop pauses the pipe, so memory stays at about one
  // piece however long the recording.
  for await (const chunk of ff.stdout as AsyncIterable<Buffer>) {
    const bytes: Buffer = odd.length ? Buffer.concat([odd, chunk]) : chunk;
    const even = bytes.length - (bytes.length % 2);
    odd = Buffer.from(bytes.subarray(even));
    const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even));
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
    total += samples.length;
    for (const piece of cutter.push(samples)) await out.write(piece);
  }
  const code: number | null = ff.exitCode ?? await new Promise((r) => ff.once("close", r));
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 300)}`);
  for (const piece of cutter.end()) await out.write(piece);
  await out.finish(total);
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
