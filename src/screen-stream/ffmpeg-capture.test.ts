// Capture arg-builder tests: the gdigrab (Windows) and avfoundation (macOS)
// input devices differ; the VP8/RTP encode tail is shared. Runtime capture
// (ffmpeg spawn, device discovery, macOS Screen Recording permission) is
// verified on-device, not here.

import { describe, it, expect } from "vitest";
import { buildFfmpegArgs, buildMacFfmpegArgs, startCapture } from "./ffmpeg-capture.js";

describe("buildFfmpegArgs (Windows gdigrab)", () => {
  it("captures the target region and packetizes VP8/RTP", () => {
    const args = buildFfmpegArgs({ x: 10, y: 20, width: 1920, height: 1080 }, 15, 5004);
    const line = args.join(" ");
    expect(args).toContain("gdigrab");
    expect(args).toContain("desktop");
    expect(line).toContain("-video_size 1920x1080");
    expect(line).toContain("rtp://127.0.0.1:5004");
    expect(args).toContain("libvpx");
  });
});

describe("buildMacFfmpegArgs (macOS avfoundation)", () => {
  it("captures the avfoundation screen device, not gdigrab", () => {
    const args = buildMacFfmpegArgs("3", 15, 5004);
    const line = args.join(" ");
    expect(args).toContain("avfoundation");
    expect(args).not.toContain("gdigrab");
    expect(args).toContain("3:none");
    // output -r sets the rate (avfoundation input framerate is unreliable)
    expect(line).toContain("-r 15");
    expect(line).toContain("rtp://127.0.0.1:5004");
    expect(args).toContain("libvpx");
  });

  it("negotiates the input format (no -pixel_format pin) for portability", () => {
    const args = buildMacFfmpegArgs("3", 15, 5004);
    // Pinning the input pixel format breaks on screens that don't offer it; the
    // device negotiates its native format and the encode tail converts to yuv420p.
    expect(args).not.toContain("-pixel_format");
    expect(args.join(" ")).toContain("-pix_fmt yuv420p"); // encoder side, kept
  });
});

describe("startCapture device mutex", () => {
  // The screen-capture device is a single OS resource; a second concurrent
  // capture is refused instead of starving both into black frames. Stopping each
  // handle before its async UDP bind callback fires skips the real ffmpeg launch.
  it("refuses a second concurrent capture and re-allows after release", async () => {
    const noop = (): void => {};
    const e1: string[] = [];
    const h1 = startCapture({ rtpPort: 45123 }, noop, (m) => e1.push(m));

    const e2: string[] = [];
    const h2 = startCapture({ rtpPort: 45124 }, noop, (m) => e2.push(m));
    await Promise.resolve(); // flush the deferred refusal
    expect(e2[0]).toMatch(/already being streamed/i);
    h2.stop();

    h1.stop(); // releases the device

    const e3: string[] = [];
    const h3 = startCapture({ rtpPort: 45125 }, noop, (m) => e3.push(m));
    await Promise.resolve();
    expect(e3.some((m) => /already being streamed/i.test(m))).toBe(false);
    h3.stop();
  });
});
