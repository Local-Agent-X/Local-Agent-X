/**
 * Screen Capture Tool — captures screenshots using native APIs.
 * Uses PowerShell on Windows for zero-dependency screenshots.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const TMP_DIR = join(homedir(), ".lax", "voice-tmp");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

function tmpPath(ext: string): string {
  return join(TMP_DIR, `screen_${randomBytes(6).toString("hex")}.${ext}`);
}

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

/** Validate and coerce a value to a finite number, or throw */
function safeNum(val: unknown, name: string): number {
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}: must be a finite number`);
  return n;
}

/** Capture the screen using PowerShell + .NET */
export function captureScreen(options: ScreenCaptureOptions = {}): ScreenCaptureResult {
  const format = options.format ?? "png";
  if (!/^(png|jpg)$/.test(format)) throw new Error(`Invalid format: ${format}`);
  const outPath = tmpPath(format);
  const scale = safeNum(options.scale ?? 1.0, "scale");

  let psScript: string;

  if (options.region) {
    const x = safeNum(options.region.x, "region.x");
    const y = safeNum(options.region.y, "region.y");
    const width = safeNum(options.region.width, "region.width");
    const height = safeNum(options.region.height, "region.height");
    psScript = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$w = ${width}; $h = ${height}
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x}, ${y}, 0, 0, [System.Drawing.Size]::new($w, $h))
$g.Dispose()
`;
  } else {
    const monitorIdx = safeNum(options.monitor ?? 0, "monitor");
    psScript = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$screen = $screens[${monitorIdx}]
$bounds = $screen.Bounds
$w = $bounds.Width; $h = $bounds.Height
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, [System.Drawing.Size]::new($w, $h))
$g.Dispose()
`;
  }

  // Optionally scale down
  if (scale < 1.0) {
    psScript += `
$newW = [int]($w * ${scale}); $newH = [int]($h * ${scale})
$scaled = New-Object System.Drawing.Bitmap($newW, $newH)
$g2 = [System.Drawing.Graphics]::FromImage($scaled)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $newW, $newH)
$g2.Dispose()
$bmp.Dispose()
$bmp = $scaled
`;
  }

  if (format === "jpg") {
    const q = safeNum(options.quality ?? 85, "quality");
    psScript += `
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters(1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, ${q}L)
$bmp.Save('${outPath.replace(/\\/g, "\\\\")}', $codec, $params)
`;
  } else {
    psScript += `
$bmp.Save('${outPath.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
`;
  }

  psScript += `
$bmp.Dispose()
Write-Output "$w,$h"
`;

  const scriptPath = join(TMP_DIR, `capture_${randomBytes(6).toString("hex")}.ps1`);
  writeFileSync(scriptPath, psScript, "utf-8");

  try {
    const output = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { encoding: "utf-8", timeout: 10_000, windowsHide: true },
    ).trim();

    try { unlinkSync(scriptPath); } catch {}

    if (!existsSync(outPath)) throw new Error("Screenshot capture failed");

    const image = readFileSync(outPath);
    const [w, h] = output.split(",").map(Number);

    return {
      image,
      format,
      width: Math.round((w || 1920) * scale),
      height: Math.round((h || 1080) * scale),
      capturedAt: new Date().toISOString(),
    };
  } finally {
    try { unlinkSync(outPath); } catch {}
    try { unlinkSync(scriptPath); } catch {}
  }
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

/** List available monitors */
export function listMonitors(): Array<{ index: number; name: string; width: number; height: number; primary: boolean }> {
  try {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$i = 0
foreach ($s in $screens) {
  Write-Output "$i|$($s.DeviceName)|$($s.Bounds.Width)|$($s.Bounds.Height)|$($s.Primary)"
  $i++
}
`;
    const scriptPath = join(TMP_DIR, `monitors_${randomBytes(6).toString("hex")}.ps1`);
    writeFileSync(scriptPath, ps, "utf-8");
    let output = "";
    try {
      output = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { encoding: "utf-8", timeout: 5000, windowsHide: true },
      ).trim();
    } finally {
      try { unlinkSync(scriptPath); } catch {}
    }

    return output.split("\n").filter(Boolean).map((line) => {
      const [idx, name, w, h, primary] = line.trim().split("|");
      return {
        index: parseInt(idx),
        name: name || `Monitor ${idx}`,
        width: parseInt(w) || 1920,
        height: parseInt(h) || 1080,
        primary: primary === "True",
      };
    });
  } catch {
    return [{ index: 0, name: "Primary", width: 1920, height: 1080, primary: true }];
  }
}
