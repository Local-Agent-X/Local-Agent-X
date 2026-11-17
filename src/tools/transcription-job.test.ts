// Local transcription runs as a hidden background job that writes its windows
// to a file: a call returns what is done within its wait, a second call joins
// the same job instead of starting another, a job stopped halfway resumes
// after the last finished window, and a finished file is read straight back
// (the 30-minute interview that outran the tool's limit, 2026-11-17).
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "lax-transcripts-"));
vi.mock("../lax-data-dir.js", () => ({ getLaxDir: () => dataDir }));
vi.mock("../voice/whisper-stream.js", () => ({
  buildConfig: () => ({}),
  createWhisperTranscriber: () => ({ transcribe: async () => "from wasm" }),
}));

const { chainFrom, jobThreads, progressOf, transcribeInBackground, _runningJobsForTest } = await import("./transcription-job.js");
const { openRecognizer } = await import("./transcription-job-child.js");
import type { ChildJob, JobLine } from "./transcription-job-child.js";

const recording = join(dataDir, "talk.mp4");
writeFileSync(recording, "not really a video");
const model = { encoder: "e", decoder: "d", joiner: "j", tokens: "t", modelDir: "m", variant: "parakeet-v3" as const, kind: "nemo_transducer" as const };
const request = (over: Partial<Parameters<typeof transcribeInBackground>[0]> = {}) =>
  ({ path: recording, model, ffmpeg: "ffmpeg", durationSec: 90, startSec: 0, maxSpanSec: 1800, waitMs: 2_000, ...over });

const seg = (start: number, end: number, text = `words at ${start}`): JobLine => ({ t: "seg", start, end, text });

/** A child that writes the windows it is given, one per tick, then exits. */
function fakeSpawner(windows: Array<[number, number]>, opts: { exitEarly?: boolean; tickMs?: number } = {}) {
  const jobs: ChildJob[] = [];
  const spawner = (job: ChildJob) => {
    jobs.push(job);
    const child = new EventEmitter() as EventEmitter & { kill(): void };
    child.kill = () => child.emit("exit", 0);
    let i = 0;
    const tick = setInterval(() => {
      if (i < windows.length) { appendFileSync(job.out, `${JSON.stringify(seg(...windows[i++]))}\n`); return; }
      clearInterval(tick);
      if (!opts.exitEarly) appendFileSync(job.out, `${JSON.stringify({ t: "done", end: windows.at(-1)?.[1] ?? job.startSec })}\n`);
      child.emit("exit", 0);
    }, opts.tickMs ?? 50);
    return child as never;
  };
  return { spawner, jobs };
}

beforeEach(() => {
  _runningJobsForTest().clear();
  rmSync(join(dataDir, "transcripts"), { recursive: true, force: true });
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("chainFrom", () => {
  it("takes the unbroken run of windows from the asked-for second and stops at a gap", () => {
    const lines = [seg(30, 60), seg(0, 30), seg(90, 120)];
    expect(chainFrom(lines, 0)).toMatchObject({ end: 60 });
    expect(chainFrom(lines, 45).segments.map((s) => s.start)).toEqual([30]);
    expect(chainFrom(lines, 60)).toEqual({ segments: [], end: 60 });
  });
});

describe("progressOf", () => {
  it("is complete at the end of the span asked for, or where a finished job reached the real end", () => {
    const req = request({ durationSec: 7200, maxSpanSec: 60 });
    expect(progressOf([seg(0, 30), seg(30, 60)], req, true).complete).toBe(true);
    const short = request({ durationSec: 95 });
    expect(progressOf([seg(0, 30), seg(30, 60), seg(60, 90)], short, false).complete).toBe(false);
    expect(progressOf([seg(0, 30), seg(30, 60), seg(60, 90), { t: "done", end: 90 }], short, false).complete).toBe(true);
  });

  it("reports why a job stopped when nothing replaced it", () => {
    expect(progressOf([{ t: "error", message: "ffmpeg exited with code 1" }], request(), false).error).toBe("ffmpeg exited with code 1");
    expect(progressOf([{ t: "error", message: "old" }], request(), true).error).toBeUndefined();
  });
});

describe("transcribeInBackground", () => {
  it("returns the whole recording when it finishes inside the wait", async () => {
    const { spawner, jobs } = fakeSpawner([[0, 30], [30, 60], [60, 90]]);
    const p = await transcribeInBackground(request(), spawner);
    expect(p).toMatchObject({ complete: true, coveredTo: 90 });
    expect(p.segments.map((s) => s.start)).toEqual([0, 30, 60]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ input: recording, startSec: 0, spanSec: 0, threads: jobThreads() });
  });

  it("answers with what is done when the wait runs out, and the next call joins the same job", async () => {
    const { spawner, jobs } = fakeSpawner([[0, 30], [30, 60], [60, 90]], { tickMs: 400 });
    const first = await transcribeInBackground(request({ waitMs: 60 }), spawner);
    expect(first.complete).toBe(false);
    expect(first.running).toBe(true);
    const second = await transcribeInBackground(request({ startSec: first.coveredTo }), spawner);
    expect(second.complete).toBe(true);
    expect(jobs).toHaveLength(1);
  });

  it("resumes after the last finished window when a job stopped halfway", async () => {
    const stopped = fakeSpawner([[0, 30]], { exitEarly: true });
    const partial = await transcribeInBackground(request(), stopped.spawner);
    expect(partial).toMatchObject({ complete: false, running: false, coveredTo: 30 });
    const rest = fakeSpawner([[30, 60], [60, 90]]);
    const done = await transcribeInBackground(request(), rest.spawner);
    expect(rest.jobs[0].startSec).toBe(30);
    expect(done.segments.map((s) => s.start)).toEqual([0, 30, 60]);
  });

  it("reads a finished recording straight back without starting a job", async () => {
    await transcribeInBackground(request(), fakeSpawner([[0, 30], [30, 60], [60, 90]]).spawner);
    const again = fakeSpawner([]);
    const p = await transcribeInBackground(request(), again.spawner);
    expect(p.complete).toBe(true);
    expect(again.jobs).toHaveLength(0);
  });
});

describe("jobThreads", () => {
  it("uses half the cores, at least one and at most eight", () => {
    expect([jobThreads(1), jobThreads(4), jobThreads(24)]).toEqual([1, 2, 8]);
  });
});

describe("openRecognizer", () => {
  it("falls back to the WASM build when the native addon will not load", async () => {
    const job = { model } as ChildJob;
    expect(openRecognizer(job, () => async () => "native").native).toBe(true);
    const fallback = openRecognizer(job, () => { throw new Error("no prebuilt binary for this platform"); });
    expect(fallback.native).toBe(false);
    expect(await fallback.recognize(new Int16Array(16_000))).toBe("from wasm");
  });
});
