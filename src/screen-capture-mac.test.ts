import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScreencaptureArgs, buildSipsArgs, cleanupCaptureFiles, pngDimensions } from "./screen-capture-mac.js";
import { grabInputArgs, parseMacMonitorOutput, parseXrandrMonitorOutput } from "./screen-capture.js";

// The screenshot path was Windows-only (gdigrab + -offset_x), so every macOS
// capture died with "Unrecognized option 'offset_x'". captureScreen now
// dispatches per platform; these tests pin the pure arg builders.

describe("buildScreencaptureArgs — macOS native capture argv", () => {
  it("explicitly captures only the primary display by default", () => {
    expect(buildScreencaptureArgs("/tmp/x.png", {})).toEqual(["-x", "-t", "png", "-D", "1", "/tmp/x.png"]);
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

  it("rejects invalid monitor and region values clearly", () => {
    expect(() => buildScreencaptureArgs("/tmp/x.png", { monitor: -1 })).toThrow(/non-negative integer/);
    expect(() => buildScreencaptureArgs("/tmp/x.png", { monitor: 1.5 })).toThrow(/non-negative integer/);
    expect(() => buildScreencaptureArgs("/tmp/x.png", {
      region: { x: Number.NaN, y: 0, width: 100, height: 100 },
    })).toThrow(/finite numbers/);
    expect(() => buildScreencaptureArgs("/tmp/x.png", {
      region: { x: 0, y: 0, width: 0, height: 100 },
    })).toThrow(/greater than zero/);
  });

  it("refuses secondary-display-relative regions instead of capturing the wrong area", () => {
    expect(() => buildScreencaptureArgs("/tmp/x.png", {
      monitor: 1,
      region: { x: 10, y: 20, width: 300, height: 400 },
    })).toThrow(/only supported on the primary display/);
  });
});

describe("cleanupCaptureFiles — macOS fan-out cleanup", () => {
  it("removes exact capture outputs and unexpected numbered siblings only", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-mac-shot-"));
    try {
      for (const name of ["shot_abc123.png", "shot_abc1232.png", "shot_abc123 3.png", "shot_abc123_out.jpg", "shot_abc123_notes.png", "shot_other2.png"]) {
        writeFileSync(join(dir, name), "x");
      }
      cleanupCaptureFiles(dir, "abc123", "jpg");
      expect(readdirSync(dir).sort()).toEqual(["shot_abc123_notes.png", "shot_other2.png"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("native monitor output parsers", () => {
  it("parses macOS multi-monitor geometry, primary identity, and negative offsets", () => {
    const output = [
      "0|Built-in Retina Display|0|0|1728|1117|true",
      "1|Studio Display|-2560|-323|2560|1440|false",
    ].join("\n");
    expect(parseMacMonitorOutput(output)).toEqual([
      { index: 0, name: "Built-in Retina Display", x: 0, y: 0, width: 1728, height: 1117, primary: true },
      { index: 1, name: "Studio Display", x: -2560, y: -323, width: 2560, height: 1440, primary: false },
    ]);
  });

  it("parses xrandr connected outputs with primary and signed geometry", () => {
    const output = [
      "DP-1 connected 1920x1080-1920+120 (normal left inverted right x axis y axis) 510mm x 290mm",
      "eDP-1 connected primary 2560x1440+0+0 (normal left inverted right x axis y axis) 310mm x 170mm",
      "HDMI-1 disconnected (normal left inverted right x axis y axis)",
    ].join("\n");
    expect(parseXrandrMonitorOutput(output)).toEqual([
      { index: 0, name: "DP-1", x: -1920, y: 120, width: 1920, height: 1080, primary: false },
      { index: 1, name: "eDP-1", x: 0, y: 0, width: 2560, height: 1440, primary: true },
    ]);
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

  it("formats a negative xrandr monitor origin without a '+-' offset", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const args = grabInputArgs({ x: -1920, y: 120, width: 1920, height: 1080 });
    expect(args[args.indexOf("-i") + 1]).toMatch(/^:\d[\d.]*-1920,120$/);
  });

  it("uses gdigrab with -offset_x/-offset_y on windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const args = grabInputArgs({ x: -1920, y: 0, width: 1920, height: 1080 });
    expect(args).toContain("gdigrab");
    expect(args[args.indexOf("-offset_x") + 1]).toBe("-1920");
    expect(args[args.indexOf("-i") + 1]).toBe("desktop");
  });
});
