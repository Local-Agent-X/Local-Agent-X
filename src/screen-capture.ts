/**
 * Screen Capture Tool — captures screenshots using native APIs.
 * Uses PowerShell on Windows for zero-dependency screenshots.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { randomBytes } from "node:crypto";
import { ffmpegBin } from "./ffmpeg-bin.js";
import { captureScreenMacImpl } from "./screen-capture-mac.js";

const FFMPEG = ffmpegBin();

// Windows monitor enumeration still shells a tiny PowerShell script. That's
// benign: enumeration isn't capture, so Defender's AMSI never flags it. The
// Windows screenshot itself uses ffmpeg gdigrab because AMSI blocks the
// System.Drawing CopyFromScreen pattern as a screen-grabber signature.
const TMP_DIR = join(getLaxDir(), "voice-tmp");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

export interface ScreenCaptureOptions {
  /** Capture a specific monitor (0-based index). Omit for primary. */
  monitor?: number;
  /** Capture a specific region: {x, y, width, height} */
  region?: { x: number; y: number; width: number; height: number };
  /** Output format */
  format?: "png" | "jpg";
  /** JPEG quality (1-100) */
  quality?: number;
  /** Scale factor (0.1-1.0) to reduce size */
  scale?: number;
}

export interface ScreenCaptureResult {
  image: Buffer;
  format: string;
  width: number;
  height: number;
  capturedAt: string;
}

export interface MonitorInfo {
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

/** Validate and coerce a value to a finite number, or throw */
function safeNum(val: unknown, name: string): number {
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}: must be a finite number`);
  return n;
}

/** Per-platform ffmpeg grab input. Windows: gdigrab (deliberately NOT a
 *  PowerShell script — Defender's AMSI blocks the System.Drawing
 *  CopyFromScreen pattern as a screen-grabber signature, which killed
 *  WhatsApp/Telegram screenshot delivery; ffmpeg is an external binary and
 *  not subject to AMSI script scanning). Linux: x11grab, the direct
 *  equivalent (offset rides on the -i display spec instead of offset_x/y).
 *  macOS never reaches here — it dispatches to the native `screencapture`
 *  path in screen-capture-mac.ts before the ffmpeg branch. */
export function grabInputArgs(target: { x: number; y: number; width: number; height: number }): string[] {
  const size = `${Math.round(target.width)}x${Math.round(target.height)}`;
  if (process.platform === "linux") {
    const x = Math.round(target.x);
    return [
      "-f", "x11grab",
      "-framerate", "1",
      "-video_size", size,
      "-i", `${process.env.DISPLAY || ":0.0"}${x >= 0 ? "+" : ""}${x},${Math.round(target.y)}`,
    ];
  }
  return [
    "-f", "gdigrab",
    "-framerate", "1",
    "-offset_x", String(Math.round(target.x)),
    "-offset_y", String(Math.round(target.y)),
    "-video_size", size,
    "-i", "desktop",
  ];
}

export function captureScreen(options: ScreenCaptureOptions = {}): ScreenCaptureResult {
  const format = options.format ?? "png";
  if (!/^(png|jpg)$/.test(format)) throw new Error(`Invalid format: ${format}`);
  const scale = Math.min(1, Math.max(0.1, safeNum(options.scale ?? 1.0, "scale")));

  // LLMs love to auto-fill optional struct args with zeros —
  // `region:{x:0,y:0,width:0,height:0}` arrives whenever the model
  // "completes" the schema even though the user didn't ask for a region. A
  // zero-dimension region would hand ffmpeg a 0x0 grab. Treat any region
  // with non-positive width/height as "no region".
  let effectiveRegion = options.region;
  if (effectiveRegion) {
    const w = Number(effectiveRegion.width);
    const h = Number(effectiveRegion.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      effectiveRegion = undefined;
    }
  }

  // macOS: the native `screencapture` CLI addresses displays by number. An
  // explicit monitor is checked against AppKit's native display enumeration;
  // omission stays primary-only through screencapture's `-D 1` selector.
  if (process.platform === "darwin") {
    if (options.monitor != null) {
      const monitorIdx = safeNum(options.monitor, "monitor");
      const monitors = listMonitors();
      if (!Number.isInteger(monitorIdx) || monitorIdx < 0 || !monitors.some((m) => m.index === monitorIdx)) {
        throw monitorRangeError(monitorIdx, monitors);
      }
    }
    return captureScreenMacImpl({ ...options, format, scale, region: effectiveRegion }, TMP_DIR);
  }

  // Resolve the capture rectangle in virtual-desktop coordinates. gdigrab's
  // `desktop` input shares the origin Screen.Bounds reports — primary
  // monitor at (0,0), other monitors offset from it (can be negative).
  const monitors = listMonitors();
  let target: { x: number; y: number; width: number; height: number };
  if (options.monitor != null) {
    const monitorIdx = safeNum(options.monitor, "monitor");
    const m = Number.isInteger(monitorIdx) && monitorIdx >= 0
      ? monitors.find((candidate) => candidate.index === monitorIdx)
      : undefined;
    if (!m) {
      throw monitorRangeError(monitorIdx, monitors);
    }
    target = { x: m.x, y: m.y, width: m.width, height: m.height };
  } else {
    // Default to the PRIMARY monitor, not screen index 0 — they aren't
    // always the same, and the old index-0 default mismatched the
    // "captured primary" metadata vision-tools reports.
    const primary = monitors.find(m => m.primary) ?? monitors[0];
    if (!primary) throw new Error("No monitors detected. Check that the native display service is available and retry.");
    target = { x: primary.x, y: primary.y, width: primary.width, height: primary.height };
  }

  // Region is RELATIVE to the chosen monitor's top-left.
  if (effectiveRegion) {
    target = {
      x: target.x + safeNum(effectiveRegion.x, "region.x"),
      y: target.y + safeNum(effectiveRegion.y, "region.y"),
      width: safeNum(effectiveRegion.width, "region.width"),
      height: safeNum(effectiveRegion.height, "region.height"),
    };
  }

  const outW = Math.max(1, Math.round(target.width * scale));
  const outH = Math.max(1, Math.round(target.height * scale));

  const args = [
    "-hide_banner", "-loglevel", "error",
    ...grabInputArgs(target),
    "-frames:v", "1",
  ];
  if (scale < 1) args.push("-vf", `scale=${outW}:${outH}`);
  args.push("-f", "image2pipe");
  if (format === "jpg") {
    args.push("-vcodec", "mjpeg", "-q:v", String(mjpegQuality(options.quality ?? 85)));
  } else {
    args.push("-vcodec", "png");
  }
  args.push("pipe:1");

  let image: Buffer;
  try {
    image = execFileSync(FFMPEG, args, { maxBuffer: 64 * 1024 * 1024, timeout: 15_000, windowsHide: true });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const reason = (err.stderr ? err.stderr.toString().trim() : "") || err.message || "unknown ffmpeg failure";
    throw new Error(`Screenshot capture failed: ${reason.split("\n").slice(0, 3).join(" | ")}`);
  }
  if (!image || image.length === 0) throw new Error("Screenshot capture failed: ffmpeg produced no output");

  return {
    image,
    format,
    width: outW,
    height: outH,
    capturedAt: new Date().toISOString(),
  };
}

function monitorRangeError(index: number, monitors: MonitorInfo[]): Error {
  const list = monitors.map((m) => `${m.index}=${m.name}${m.primary ? " (primary)" : ""}`).join(", ");
  return new Error(
    `Monitor index ${index} out of range. Connected monitors: ${list || "(none detected)"}. ` +
    "Call list_monitors first or omit monitor for primary.",
  );
}

/** Map the 1-100 quality scale (100 = best) to ffmpeg mjpeg's -q:v range
 *  (2 = best, 31 = worst). */
function mjpegQuality(quality: number): number {
  const clamped = Math.min(100, Math.max(1, safeNum(quality, "quality")));
  return Math.min(31, Math.max(2, Math.round(2 + ((100 - clamped) / 100) * 29)));
}

/** Capture screen and return as base64 data URI */
export function captureScreenBase64(options: ScreenCaptureOptions = {}): {
  dataUri: string;
  width: number;
  height: number;
  capturedAt: string;
} {
  const result = captureScreen({ ...options, format: "jpg", quality: options.quality ?? 80 });
  const b64 = result.image.toString("base64");
  return {
    dataUri: `data:image/jpeg;base64,${b64}`,
    width: result.width,
    height: result.height,
    capturedAt: result.capturedAt,
  };
}

export function parseMacMonitorOutput(output: string): MonitorInfo[] {
  return parseDelimitedMonitors(output);
}

export function parseXrandrMonitorOutput(output: string): MonitorInfo[] {
  const monitors: MonitorInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+) connected( primary)?(?: \([^)]*\))? (\d+)x(\d+)([+-]\d+)([+-]\d+)/);
    if (!match) continue;
    monitors.push({
      index: monitors.length,
      name: match[1],
      x: Number(match[5]),
      y: Number(match[6]),
      width: Number(match[3]),
      height: Number(match[4]),
      primary: Boolean(match[2]),
    });
  }
  return monitors;
}

function parseDelimitedMonitors(output: string): MonitorInfo[] {
  if (!output.trim()) return [];
  return output.trim().split(/\r?\n/).map((line, index) => {
    const [nativeIndex, name, x, y, width, height, primary] = line.trim().split("|");
    const values = [nativeIndex, x, y, width, height].map(Number);
    if (values.some((value) => !Number.isFinite(value)) || values[3] <= 0 || values[4] <= 0) {
      throw new Error(`Invalid native monitor data at line ${index + 1}`);
    }
    return {
      index,
      name: name || `Monitor ${index}`,
      x: values[1],
      y: values[2],
      width: values[3],
      height: values[4],
      primary: primary === "true",
    };
  });
}

function listWindowsMonitors(): MonitorInfo[] {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$i = 0
foreach ($s in $screens) {
  Write-Output "$i|$($s.DeviceName)|$($s.Bounds.X)|$($s.Bounds.Y)|$($s.Bounds.Width)|$($s.Bounds.Height)|$($s.Primary)"
  $i++
}
`;
  const scriptPath = join(TMP_DIR, `monitors_${randomBytes(6).toString("hex")}.ps1`);
  writeFileSync(scriptPath, ps, "utf-8");
  try {
    const output = execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { encoding: "utf-8", timeout: 5000, windowsHide: true },
    ).trim();
    return parseDelimitedMonitors(output.replace(/\|True$/gm, "|true").replace(/\|False$/gm, "|false"));
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }
}

function listMacMonitors(): MonitorInfo[] {
  const script = [
    'ObjC.import("AppKit")',
    "var screens = $.NSScreen.screens",
    "var lines = []",
    "for (var i = 0; i < screens.count; i++) {",
    "  var screen = screens.objectAtIndex(i)",
    "  var frame = screen.frame",
    '  lines.push([i, ObjC.unwrap(screen.localizedName), frame.origin.x, frame.origin.y, frame.size.width, frame.size.height, i === 0].join("|"))',
    "}",
    'lines.join("\\n")',
  ].join(";");
  const output = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    encoding: "utf-8", timeout: 5000,
  });
  return parseMacMonitorOutput(output);
}

/** List available monitors using the platform's native display enumerator. */
export function listMonitors(): MonitorInfo[] {
  try {
    if (process.platform === "win32") return listWindowsMonitors();
    if (process.platform === "darwin") return listMacMonitors();
    if (process.platform === "linux") {
      const output = execFileSync("xrandr", ["--query"], { encoding: "utf-8", timeout: 5000 });
      return parseXrandrMonitorOutput(output);
    }
    return [];
  } catch {
    return process.platform === "win32"
      ? [{ index: 0, name: "Primary", x: 0, y: 0, width: 1920, height: 1080, primary: true }]
      : [];
  }
}
