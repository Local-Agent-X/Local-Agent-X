// Capture arg-builder tests: the gdigrab (Windows) and avfoundation (macOS)
// input devices differ; the VP8/RTP encode tail is shared. Runtime capture
// (ffmpeg spawn, device discovery, macOS Screen Recording permission) is
// verified on-device, not here.

import { describe, it, expect } from "vitest";
import { buildFfmpegArgs, buildMacFfmpegArgs } from "./ffmpeg-capture.js";

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
});
