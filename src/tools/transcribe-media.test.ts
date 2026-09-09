import { describe, it, expect, vi, beforeEach } from "vitest";

// The window walk is the part that has to be right: it decides how much of a
// file gets read, that an hours-long recording is never decoded whole, and
// where a caller resumes. ffmpeg and the speech model are stubbed so the walk
// itself is what's under test.
const probe = vi.fn();
const decode = vi.fn();
const transcribe = vi.fn();

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

const { transcribeMediaFile, formatTranscript, MAX_SPAN_SEC } = await import("./transcribe-media.js");

const SPEECH = new Int16Array(16_000);

beforeEach(() => {
  probe.mockReset(); decode.mockReset(); transcribe.mockReset();
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

describe("formatTranscript", () => {
  it("renders mm:ss under an hour and h:mm:ss past it", () => {
    const out = formatTranscript({
      windows: [{ startSec: 0, text: "a" }, { startSec: 605, text: "b" }, { startSec: 3725, text: "c" }],
      durationSec: 4000, startSec: 0, endSec: 4000, hasMore: false,
    });
    expect(out).toBe("[00:00] a\n[10:05] b\n[1:02:05] c");
  });
});
