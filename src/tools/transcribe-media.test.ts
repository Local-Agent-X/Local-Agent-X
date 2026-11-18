import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Two routes. On this computer (the default) the file goes to a background
// job (transcription-job.ts, stubbed here); a cloud provider's windows are
// walked in-process, and that walk decides how much of a file gets read, that
// an hours-long recording is never decoded whole, and where a caller resumes.
// ffmpeg and the speech model are stubbed so the routing and the walk are
// what's under test.
const probe = vi.fn();
const decode = vi.fn();
const transcribe = vi.fn();
const job = vi.fn();

vi.mock("../ffmpeg-run.js", () => ({
  isFfmpegAvailable: async () => true,
  probeMedia: (...a: unknown[]) => probe(...a),
}));
vi.mock("../bridge-voice/audio-codec.js", () => ({
  decodeFileSegmentToPcm16: (...a: unknown[]) => decode(...a),
}));
vi.mock("../bridge-voice/stt-helper.js", () => ({
  getSharedTranscriber: async () => ({ transcribe: (...a: unknown[]) => transcribe(...a) }),
}));
vi.mock("../local-only-policy.js", () => ({ isLocalOnlyMode: () => false }));
vi.mock("./transcription-job.js", () => ({ transcribeInBackground: (...a: unknown[]) => job(...a) }));
vi.mock("../voice/whisper-model-fetch.js", () => ({
  ensureWhisperModelDownloaded: async (_: unknown, o: { variant: string }) => ({ variant: o.variant }),
}));
vi.mock("../voice/vad-model-fetch.js", () => ({ ensureVadModelDownloaded: async () => ({ model: "silero_vad.onnx", modelDir: "." }) }));
vi.mock("../ffmpeg-bin.js", () => ({ ffmpegBin: () => "ffmpeg" }));

const { transcribeMediaFile, formatTranscript, MAX_SPAN_SEC } = await import("./transcribe-media.js");

const SPEECH = new Int16Array(16_000);
afterAll(() => { delete process.env.LAX_VOICE_STT_PROVIDER; });

beforeEach(() => {
  probe.mockReset(); decode.mockReset(); transcribe.mockReset(); job.mockReset();
  process.env.LAX_VOICE_STT_PROVIDER = "groq";
  decode.mockResolvedValue(SPEECH);
  transcribe.mockResolvedValue("some words");
});

describe("transcribeMediaFile", () => {
  it("refuses a file with no audio track", async () => {
    probe.mockResolvedValue({ durationSec: 10, hasVideo: true, hasAudio: false });
    await expect(transcribeMediaFile("/x.mp4")).rejects.toThrow(/no audio track/);
  });

  it("walks a short file in one window", async () => {
    probe.mockResolvedValue({ durationSec: 45, hasVideo: false, hasAudio: true });
    const r = await transcribeMediaFile("/x.mp3");
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode.mock.calls[0]).toEqual(["/x.mp3", 0, 45]);
    expect(r.hasMore).toBe(false);
    expect(r.endSec).toBe(45);
  });

  it("splits a long file into bounded windows instead of decoding it whole", async () => {
    probe.mockResolvedValue({ durationSec: 150, hasVideo: false, hasAudio: true });
    await transcribeMediaFile("/x.mp3");
    expect(decode.mock.calls.map(c => [c[1], c[2]])).toEqual([[0, 60], [60, 60], [120, 30]]);
  });

  it("stops at the span cap and reports where to resume", async () => {
    probe.mockResolvedValue({ durationSec: 7200, hasVideo: false, hasAudio: true });
    const r = await transcribeMediaFile("/long.mp3");
    expect(r.endSec).toBe(MAX_SPAN_SEC);
    expect(r.hasMore).toBe(true);
    expect(r.durationSec).toBe(7200);
  });

  it("resumes from start_at without re-reading the beginning", async () => {
    probe.mockResolvedValue({ durationSec: 7200, hasVideo: false, hasAudio: true });
    const r = await transcribeMediaFile("/long.mp3", { startSec: MAX_SPAN_SEC });
    expect(decode.mock.calls[0][1]).toBe(MAX_SPAN_SEC);
    expect(r.startSec).toBe(MAX_SPAN_SEC);
    expect(r.hasMore).toBe(true);
  });

  it("stamps each window with the second it started at", async () => {
    probe.mockResolvedValue({ durationSec: 120, hasVideo: false, hasAudio: true });
    transcribe.mockResolvedValueOnce("first minute").mockResolvedValueOnce("second minute");
    const r = await transcribeMediaFile("/x.mp3");
    expect(r.windows).toEqual([
      { startSec: 0, text: "first minute" },
      { startSec: 60, text: "second minute" },
    ]);
  });

  it("drops silent windows but keeps walking past them", async () => {
    probe.mockResolvedValue({ durationSec: 180, hasVideo: false, hasAudio: true });
    decode.mockResolvedValueOnce(SPEECH).mockResolvedValueOnce(new Int16Array(10)).mockResolvedValueOnce(SPEECH);
    transcribe.mockResolvedValueOnce("before").mockResolvedValueOnce("after");
    const r = await transcribeMediaFile("/x.mp3");
    expect(decode).toHaveBeenCalledTimes(3);
    expect(r.windows.map(w => w.startSec)).toEqual([0, 120]);
  });

  it("stops at the real end of a stream whose container declares no duration", async () => {
    probe.mockResolvedValue({ durationSec: 0, hasVideo: false, hasAudio: true });
    decode.mockResolvedValueOnce(SPEECH).mockResolvedValueOnce(new Int16Array(0));
    const r = await transcribeMediaFile("/stream.ogg");
    expect(decode).toHaveBeenCalledTimes(2);
    expect(r.hasMore).toBe(false);
  });

  it("drops whisper hallucinations rather than reporting them as speech", async () => {
    probe.mockResolvedValue({ durationSec: 60, hasVideo: false, hasAudio: true });
    transcribe.mockResolvedValue("Thanks for watching!");
    const r = await transcribeMediaFile("/x.mp3");
    expect(r.windows).toHaveLength(0);
  });

  it("scrubs whisper noise annotations", async () => {
    probe.mockResolvedValue({ durationSec: 60, hasVideo: false, hasAudio: true });
    transcribe.mockResolvedValue("[BLANK_AUDIO] the meeting starts now");
    const r = await transcribeMediaFile("/x.mp3");
    expect(r.windows[0].text).toBe("the meeting starts now");
  });
});

describe("transcribeMediaFile on this computer", () => {
  beforeEach(() => { delete process.env.LAX_VOICE_STT_PROVIDER; });

  it("hands the file to the background job and never decodes on the server's thread", async () => {
    probe.mockResolvedValue({ durationSec: 1809, hasVideo: true, hasAudio: true });
    job.mockResolvedValue({ segments: [{ start: 0, end: 30, text: "hello there" }, { start: 30, end: 60, text: "Thanks for watching!" }], coveredTo: 60, complete: false, running: true, native: true });
    const r = await transcribeMediaFile("/talk.mp4", { startSec: 0 });
    expect(decode).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(job.mock.calls[0][0]).toMatchObject({ path: "/talk.mp4", durationSec: 1809, startSec: 0, maxSpanSec: MAX_SPAN_SEC, vadModel: "silero_vad.onnx" });
    // A recording is transcribed with Whisper large-v3-turbo whatever voice chat uses.
    expect(job.mock.calls[0][0].model.variant).toBe("large-v3-turbo");
    expect(r.windows).toEqual([{ startSec: 0, text: "hello there" }]);
    expect(r).toMatchObject({ endSec: 60, hasMore: true, stillRunning: true });
  });

  it("reports a finished job as finished", async () => {
    probe.mockResolvedValue({ durationSec: 60, hasVideo: false, hasAudio: true });
    job.mockResolvedValue({ segments: [{ start: 0, end: 60, text: "all of it" }], coveredTo: 60, complete: true, running: false });
    const r = await transcribeMediaFile("/x.mp3");
    expect(r).toMatchObject({ endSec: 60, hasMore: false, stillRunning: false });
  });

  it("surfaces a job that failed before transcribing anything", async () => {
    probe.mockResolvedValue({ durationSec: 60, hasVideo: false, hasAudio: true });
    job.mockResolvedValue({ segments: [], coveredTo: 0, complete: false, running: false, error: "ffmpeg exited with code 1" });
    await expect(transcribeMediaFile("/x.mp3")).rejects.toThrow("ffmpeg exited with code 1");
  });
});

describe("formatTranscript", () => {
  it("renders mm:ss under an hour and h:mm:ss past it", () => {
    const out = formatTranscript({
      windows: [{ startSec: 0, text: "a" }, { startSec: 605, text: "b" }, { startSec: 3725, text: "c" }],
      durationSec: 4000, startSec: 0, endSec: 4000, hasMore: false,
    });
    expect(out).toBe("[00:00] a\n[10:05] b\n[1:02:05] c");
  });
});
