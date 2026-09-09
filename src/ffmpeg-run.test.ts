import { describe, it, expect } from "vitest";
import { parseProbeOutput } from "./ffmpeg-run.js";

// ffprobe's `default=noprint_wrappers=1` output is order-independent and lists
// one codec_type per stream. The parse has to survive: audio-only files, files
// whose container declares no duration (N/A on some streamed mp4s), and the
// stream lines arriving before or after the format line.
describe("parseProbeOutput", () => {
  it("reads duration and both stream kinds from a normal video", () => {
    const probe = parseProbeOutput("codec_type=video\ncodec_type=audio\nduration=12.480000\n");
    expect(probe).toEqual({ durationSec: 12.48, hasVideo: true, hasAudio: true });
  });

  it("marks an audio-only file as having no video track", () => {
    const probe = parseProbeOutput("codec_type=audio\nduration=90.5\n");
    expect(probe.hasVideo).toBe(false);
    expect(probe.hasAudio).toBe(true);
  });

  it("reports duration 0 — not NaN — when the container declares none", () => {
    const probe = parseProbeOutput("codec_type=audio\nduration=N/A\n");
    expect(probe.durationSec).toBe(0);
    expect(probe.hasAudio).toBe(true);
  });

  it("reports duration 0 when the duration line is absent entirely", () => {
    expect(parseProbeOutput("codec_type=video\n").durationSec).toBe(0);
  });

  it("tolerates CRLF output", () => {
    const probe = parseProbeOutput("codec_type=video\r\ncodec_type=audio\r\nduration=3.0\r\n");
    expect(probe).toEqual({ durationSec: 3, hasVideo: true, hasAudio: true });
  });

  it("does not treat a zero duration as a usable length", () => {
    expect(parseProbeOutput("duration=0.000000\ncodec_type=audio\n").durationSec).toBe(0);
  });
});
