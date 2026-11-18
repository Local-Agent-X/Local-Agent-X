/**
 * Local file transcription as a background job: the recording is recognized
 * in a hidden process of its own (transcription-job-child.ts), never on the
 * server's event loop, and what it finishes lands in a file under
 * <data dir>/transcripts/ one window at a time.
 *
 * A call waits up to its budget and returns whatever stretch is done from the
 * second it asked for. A recording longer than that keeps going in the
 * background; the next call picks up the same job (or resumes from the file
 * after a restart) instead of starting over, and a recording already done is
 * read straight back. The file is keyed on the recording's path, size and
 * modification time and on the model, so a changed file or a new model
 * transcribes afresh.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLaxDir } from "../lax-data-dir.js";
import type { WhisperModelPaths } from "../voice/whisper-model-fetch.js";
import type { ChildJob, JobLine } from "./transcription-job-child.js";

/** Seams between windows are float sums of window lengths. */
const SEAM = 0.05;
const POLL_MS = 500;

/** A recognized stretch: it covers start..end, and its speech begins at `at`. */
export interface Segment { start: number; end: number; at?: number; text: string }

export interface JobProgress {
  /** Every window from the asked-for second onward, in order, with no gap. */
  segments: Segment[];
  /** The first second NOT yet transcribed, counting from the asked-for one. */
  coveredTo: number;
  /** Covered as far as was asked (the end of the span, or of the file). */
  complete: boolean;
  /** Still transcribing in the background. */
  running: boolean;
  /** Which recognizer the job used: the native addon (several cores) or WASM. */
  native?: boolean;
  /** Why the last job stopped, when it failed and nothing newer replaced it. */
  error?: string;
}

export interface LocalJobRequest {
  path: string;
  model: WhisperModelPaths;
  /** Silero VAD model the job cuts at pauses with. */
  vadModel?: string;
  ffmpeg: string;
  /** Duration the probe reported; 0 when the container declares none. */
  durationSec: number;
  startSec: number;
  /** Most seconds of transcript one call returns. */
  maxSpanSec: number;
  waitMs: number;
}

export type Spawner = (job: ChildJob) => ChildProcess;

const running = new Map<string, ChildProcess>();

function jobFile(req: LocalJobRequest): string {
  const st = statSync(req.path);
  const key = createHash("sha256")
    .update([req.path, st.size, st.mtimeMs, req.model.variant].join("|"))
    .digest("hex").slice(0, 24);
  return join(getLaxDir(), "transcripts", `${key}.jsonl`);
}

function readLines(file: string): JobLine[] {
  if (!existsSync(file)) return [];
  const out: JobLine[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw) as JobLine); } catch { /* a line still being written */ }
  }
  return out;
}

/** The unbroken run of windows from `startSec`, and where it ends. */
export function chainFrom(lines: JobLine[], startSec: number): { segments: Segment[]; end: number } {
  const segs = lines.filter((l): l is Extract<JobLine, { t: "seg" }> => l.t === "seg").sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let end = startSec;
  for (const s of segs) {
    if (s.end <= end + SEAM) continue; // before the asked-for second, or already covered
    if (s.start > end + SEAM) break;
    out.push(s);
    end = s.end;
  }
  return { segments: out, end };
}

/** Where the recording ends: the probe's duration, else where a finished job stopped. */
function fileEnd(lines: JobLine[], durationSec: number): number {
  if (durationSec > 0) return durationSec;
  const done = lines.filter((l): l is Extract<JobLine, { t: "done" }> => l.t === "done");
  return done.length ? Math.max(...done.map((d) => d.end)) : Infinity;
}

export function progressOf(lines: JobLine[], req: LocalJobRequest, isRunning: boolean): JobProgress {
  const { segments, end } = chainFrom(lines, req.startSec);
  const target = Math.min(fileEnd(lines, req.durationSec), req.startSec + req.maxSpanSec);
  const kept = segments.filter((s) => s.start < target);
  const coveredTo = Math.min(end, target);
  const last = lines[lines.length - 1];
  const engine = [...lines].reverse().find((l): l is Extract<JobLine, { t: "engine" }> => l.t === "engine");
  // A finished job whose last window ends where this chain does reached the
  // file's real end, which a container's declared duration can overstate.
  const reachedEnd = lines.some((l) => l.t === "done" && Math.abs(l.end - end) <= SEAM);
  return {
    segments: kept,
    coveredTo,
    complete: reachedEnd || coveredTo >= target - SEAM,
    running: isRunning,
    native: engine?.native,
    error: !isRunning && last?.t === "error" ? last.message : undefined,
  };
}

/** Several cores, never all of them: the user's own apps keep running. */
export function jobThreads(cores = availableParallelism()): number {
  return Math.max(1, Math.min(8, Math.floor(cores / 2)));
}

const defaultSpawner: Spawner = (job) => {
  const child = join(dirname(fileURLToPath(import.meta.url)), "transcription-job-child.js");
  // The server may itself be Electron; ELECTRON_RUN_AS_NODE makes the same
  // binary a plain Node for the child. windowsHide: no console flashes up.
  return spawn(process.execPath, [child, JSON.stringify(job)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
    windowsHide: true,
  });
};

function ensureRunning(key: string, req: LocalJobRequest, lines: JobLine[], spawner: Spawner): void {
  if (running.has(key)) return;
  const from = chainFrom(lines, req.startSec).end;
  mkdirSync(dirname(key), { recursive: true });
  const child = spawner({
    input: req.path, ffmpeg: req.ffmpeg, startSec: from, spanSec: 0,
    out: key, model: req.model, vadModel: req.vadModel, threads: jobThreads(),
  });
  running.set(key, child);
  child.once("exit", () => { if (running.get(key) === child) running.delete(key); });
  child.once("error", () => { if (running.get(key) === child) running.delete(key); });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Transcribe `req.path` from `req.startSec`, waiting up to `req.waitMs`. */
export async function transcribeInBackground(req: LocalJobRequest, spawner: Spawner = defaultSpawner): Promise<JobProgress> {
  const key = jobFile(req);
  const deadline = Date.now() + req.waitMs;
  let lines = readLines(key);
  let progress = progressOf(lines, req, running.has(key));
  if (progress.complete) return progress;
  ensureRunning(key, req, lines, spawner);
  for (;;) {
    await sleep(POLL_MS);
    lines = readLines(key);
    progress = progressOf(lines, req, running.has(key));
    if (progress.complete || !progress.running || Date.now() >= deadline) return progress;
  }
}

/** Jobs someone is already waiting on, so a repeated call does not register twice. */
const watched = new Set<string>();

/** Call `onEnd` once, with the job's final progress, when the job for this
 *  request exits. Returns the job's id, or null when no job is running for it
 *  (finished already, or never started). */
export function whenJobEnds(req: LocalJobRequest, onEnd: (p: JobProgress) => void): string | null {
  const key = jobFile(req);
  const child = running.get(key);
  if (!child) return null;
  const id = `transcribe:${basename(key, ".jsonl")}`;
  if (watched.has(key)) return id;
  watched.add(key);
  child.once("exit", () => {
    watched.delete(key);
    onEnd(progressOf(readLines(key), { ...req, maxSpanSec: Number.POSITIVE_INFINITY }, false));
  });
  return id;
}

/** Test seam. */
export function _runningJobsForTest(): Map<string, ChildProcess> { watched.clear(); return running; }
