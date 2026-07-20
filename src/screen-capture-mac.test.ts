import { describe, it, expect, afterEach } from "vitest";
import { buildScreencaptureArgs, buildSipsArgs, pngDimensions } from "./screen-capture-mac.js";
import { grabInputArgs } from "./screen-capture.js";

// The screenshot path was Windows-only (gdigrab + -offset_x), so every macOS
// capture died with "Unrecognized option 'offset_x'". captureScreen now
// dispatches per platform; these tests pin the pure arg builders.

describe("buildScreencaptureArgs — macOS native capture argv", () => {
  it("captures silently to the out file with no monitor/region flags by default", () => {
    expect(buildScreencaptureArgs("/tmp/x.png", {})).toEqual(["-x", "-t", "png", "/tmp/x.png"]);
  });

  it("maps the 0-based monitor option to screencapture's 1-based -D", () => {
    expect(buildScreencaptureArgs("/tmp/x.png", { monitor: 1 })).toContain("-D");
    expect(buildScreencaptureArgs("/tmp/x.png", { monitor: 1 })).toContain("2");
  });

  it("passes a region as -R x,y,w,h", () => {
    const args = buildScreencaptureArgs("/tmp/x.png", { region: { x: 10, y: 20, width: 300, height: 400 } });
    expect(args).toContain("-R");
    expect(args[args.indexOf("-R") + 1]).toBe("10,20,300,400");
  });
});

describe("buildSipsArgs — conversion/scaling argv", () => {
  it("returns null when no transform is needed (full-scale png)", () => {
    expect(buildSipsArgs("/a.png", "/b.png", "png", 85, null)).toBeNull();
  });

  it("converts to jpeg with a clamped quality", () => {
    const args = buildSipsArgs("/a.png", "/b.jpg", "jpg", 300, null)!;
    expect(args).toEqual(["-s", "format", "jpeg", "-s", "formatOptions", "100", "/a.png", "--out", "/b.jpg"]);
  });

  it("resamples to the target width when scaling", () => {
    const args = buildSipsArgs("/a.png", "/b.png", "png", 85, 640)!;
    expect(args).toEqual(["--resampleWidth", "640", "/a.png", "--out", "/b.png"]);
  });
});

describe("pngDimensions — IHDR parse", () => {
  it("reads width/height from a real PNG header", () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(0x49484452, 12); // "IHDR"
    png.writeUInt32BE(2816, 16);
    png.writeUInt32BE(1762, 20);
    expect(pngDimensions(png)).toEqual({ width: 2816, height: 1762 });
  });

  it("throws a clear error on non-PNG output", () => {
    expect(() => pngDimensions(Buffer.from("not a png at all, promise"))).toThrow(/no readable PNG/);
  });
});

describe("grabInputArgs — per-platform ffmpeg input", () => {
  const ORIG = process.platform;
  afterEach(() => Object.defineProperty(process, "platform", { value: ORIG }));

  it("uses x11grab with the offset on the display spec on linux", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const args = grabInputArgs({ x: 100, y: 50, width: 1920, height: 1080 });
    expect(args).toContain("x11grab");
    expect(args[args.indexOf("-i") + 1]).toMatch(/^:\d[\d.]*\+100,50$/);
    expect(args).not.toContain("-offset_x");
  });

  it("uses gdigrab with -offset_x/-offset_y on windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const args = grabInputArgs({ x: -1920, y: 0, width: 1920, height: 1080 });
    expect(args).toContain("gdigrab");
    expect(args[args.indexOf("-offset_x") + 1]).toBe("-1920");
    expect(args[args.indexOf("-i") + 1]).toBe("desktop");
  });
});
