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
const languages = vi.hoisted(() => [] as Array<string | undefined>);
vi.mock("../voice/whisper-stream.js", () => ({
  buildConfig: (_p: unknown, _provider: unknown, _threads: unknown, language?: string) => { languages.push(language); return {}; },
  createWhisperTranscriber: (_p: unknown, o?: { language?: string }) => { languages.push(o?.language); return { transcribe: async () => "from wasm" }; },
}));

const { chainFrom, jobThreads, progressOf, transcribeInBackground, whenJobEnds, _runningJobsForTest } = await import("./transcription-job.js");
const { LANGUAGE_SAMPLE_SEC, languageGate, openRecognizer, pauseCutter, pieceWriter, windowCutter } = await import("./transcription-job-child.js");
import type { ChildJob, JobLine, NativeModule, NativeVad, Piece } from "./transcription-job-child.js";

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

describe("whenJobEnds", () => {
  it("reports the whole file's progress once when the job exits, however often it is asked", async () => {
    const { spawner } = fakeSpawner([[0, 30], [30, 60], [60, 90]], { tickMs: 200 });
    const first = await transcribeInBackground(request({ waitMs: 50 }), spawner);
    expect(first.running).toBe(true);
    const ends: boolean[] = [];
    const id = whenJobEnds(request(), (p) => ends.push(p.complete));
    expect(id).toMatch(/^transcribe:/);
    expect(whenJobEnds(request(), (p) => ends.push(p.complete))).toBe(id);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(ends).toEqual([true]);
    expect(whenJobEnds(request(), () => {})).toBeNull(); // nothing running any more
  });
});

describe("jobThreads", () => {
  it("uses half the cores, at least one and at most eight", () => {
    expect([jobThreads(1), jobThreads(4), jobThreads(24)]).toEqual([1, 2, 8]);
  });
});

const RATE = 16_000;
const fakeNative = (): NativeModule => ({
  OfflineRecognizer: class {
    createStream() { return { acceptWaveform() { /* fake */ } }; }
    decode() { /* fake */ }
    getResult() { return { text: "native" }; }
    setConfig() { /* fake */ }
  },
  Vad: class {} as never,
});

describe("openRecognizer", () => {
  it("uses the native addon, and the WASM build when the addon will not load", async () => {
    const job = { model } as ChildJob;
    const native = openRecognizer(job, fakeNative);
    expect(native.native).toBe(true);
    expect(await native.recognize(new Float32Array(RATE))).toBe("native");
    const fallback = openRecognizer(job, () => { throw new Error("no prebuilt binary for this platform"); });
    expect(fallback.native).toBe(false);
    expect(await fallback.recognize(new Float32Array(RATE))).toBe("from wasm");
    // A recording can be in any language, so both builds detect it rather than assume English.
    expect(languages).toEqual(["", ""]);
  });

  it("lets a Whisper model be held to one language, without loading it again", () => {
    languages.length = 0;
    let built = 0;
    const native = (): NativeModule => ({
      OfflineRecognizer: class {
        constructor() { built++; }
        createStream() { return { acceptWaveform() { /* fake */ } }; }
        decode() { /* fake */ }
        getResult() { return { text: "words", lang: "es" }; }
        setConfig() { /* fake */ }
      },
      Vad: class {} as never,
    });
    const whisper = { ...model, kind: "whisper" as const };
    const { language } = openRecognizer({ model: whisper } as ChildJob, native);
    expect(language!.detect(new Float32Array(RATE))).toBe("es");
    language!.hold("es");
    expect(languages).toEqual(["", "es"]);
    expect(built).toBe(1);
    // Parakeet has no language to hold.
    expect(openRecognizer({ model } as ChildJob, native).language).toBeUndefined();
  });
});

// A short burst of crosstalk detected on its own came back as French in an
// English call (2026-11-18); the language is told once, before anything is written.
describe("languageGate", () => {
  const piece = (first: number, sec: number): Piece => ({ first, samples: new Float32Array(RATE * sec).fill(first) });

  it("holds the first pieces until there is enough speech, then writes them in order in that language", async () => {
    const events: string[] = [];
    const detected: number[] = [];
    const lock = {
      detect: (s: Float32Array) => { detected.push(s.length / RATE); return "en"; },
      hold: (l: string) => { events.push(`hold ${l}`); },
    };
    const gate = languageGate(lock, async (p) => { events.push(`write ${p.first}`); });
    await gate.write(piece(1, 2)); // a short burst first
    await gate.write(piece(2, 10));
    expect(events).toEqual([]);
    await gate.write(piece(3, 20));
    await gate.write(piece(4, 5));
    await gate.end();
    expect(detected).toEqual([LANGUAGE_SAMPLE_SEC]);
    expect(events).toEqual(["hold en", "write 1", "write 2", "write 3", "write 4"]);
  });

  it("decides from what there is when the recording is shorter, and passes through with no lock", async () => {
    const events: string[] = [];
    const gate = languageGate({ detect: () => "es", hold: (l) => { events.push(`hold ${l}`); } }, async (p) => { events.push(`write ${p.first}`); });
    await gate.write(piece(1, 4));
    await gate.end();
    expect(events).toEqual(["hold es", "write 1"]);
    const open: number[] = [];
    const pass = languageGate(undefined, async (p) => { open.push(p.first); });
    await pass.write(piece(7, 1));
    expect(open).toEqual([7]);
  });
});

describe("cutting the stream", () => {
  it("slices fixed windows, keeping each slice's place in the stream", () => {
    const cut = windowCutter(1);
    expect(cut.push(new Float32Array(RATE * 2.5)).map((p) => [p.first, p.samples.length])).toEqual([[0, RATE], [RATE, RATE]]);
    expect(cut.end().map((p) => [p.first, p.samples.length])).toEqual([[RATE * 2, RATE / 2]]);
  });

  it("hands the detector whole frames and passes on each utterance it finds", () => {
    const fed: number[] = [];
    const found: Array<{ start: number; samples: Float32Array }> = [];
    const vad: NativeVad = {
      acceptWaveform: (s) => { fed.push(s.length); if (fed.length === 3) found.push({ start: 512, samples: new Float32Array(1024) }); },
      isEmpty: () => found.length === 0,
      front: () => found[0],
      pop: () => { found.shift(); },
      flush: () => { found.push({ start: 4096, samples: new Float32Array(300) }); },
    };
    const cut = pauseCutter(vad);
    expect(cut.push(new Float32Array(1000))).toEqual([]);
    expect(cut.push(new Float32Array(600)).map((p) => p.first)).toEqual([512]);
    expect(fed).toEqual([512, 512, 512]); // 1600 samples: three whole frames, 64 carried
    expect(cut.end().map((p) => p.first)).toEqual([4096]);
    expect(fed.at(-1)).toBe(64);
  });
});

describe("pieceWriter", () => {
  it("writes each utterance covering the stretch since the last, stamped where its speech starts", async () => {
    const lines: JobLine[] = [];
    const heard: number[] = [];
    const job = { startSec: 60 } as ChildJob;
    const out = pieceWriter(job, async (s) => { heard.push(s.length); return "hello"; }, (l) => lines.push(l));
    await out.write({ first: RATE * 2, samples: new Float32Array(RATE * 3) });
    await out.write({ first: RATE * 10, samples: new Float32Array(RATE) });
    out.finish(RATE * 20);
    expect(lines).toEqual([
      { t: "seg", start: 60, end: 65, at: 62, text: "hello" },
      { t: "seg", start: 65, end: 71, at: 70, text: "hello" },
      { t: "seg", start: 71, end: 80, text: "" },
      { t: "done", end: 80 },
    ]);
    expect(heard[0]).toBe(RATE * 3 + RATE / 2); // a quarter second of silence either side
  });
});
