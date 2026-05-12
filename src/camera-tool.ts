/**
 * Camera Input Tool — captures webcam frames and sends to vision model.
 * Uses ffmpeg to grab frames from the default video device.
 */

import { execSync, execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const TMP_DIR = join(homedir(), ".lax", "voice-tmp");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

function tmpPath(ext: string): string {
  return join(TMP_DIR, `cam_${randomBytes(6).toString("hex")}.${ext}`);
}

export interface CaptureOptions {
  /** Video device name (Windows DirectShow). Auto-detected if omitted. */
  device?: string;
  /** Output image width */
  width?: number;
  /** Output image height */
  height?: number;
  /** Image format */
  format?: "png" | "jpg";
  /** JPEG quality (1-100) */
  quality?: number;
}

export interface CaptureResult {
  image: Buffer;
  format: string;
  width: number;
  height: number;
  capturedAt: string;
  deviceName: string;
}

/** List available video devices (Windows) */
export function listDevices(): string[] {
  try {
    const output = execSync(
      'ffmpeg -list_devices true -f dshow -i dummy 2>&1',
      { encoding: "utf-8", timeout: 5000 },
    ).toString();

    const devices: string[] = [];
    const lines = output.split("\n");
    let isVideo = false;

    for (const line of lines) {
      if (line.includes("DirectShow video devices")) isVideo = true;
      if (line.includes("DirectShow audio devices")) isVideo = false;
      if (isVideo) {
        const match = line.match(/"([^"]+)"/);
        if (match && !match[1].includes("@device")) {
          devices.push(match[1]);
        }
      }
    }

    return devices;
  } catch (err: any) {
    // ffmpeg outputs device list to stderr with non-zero exit
    const output = err.stderr?.toString() || err.stdout?.toString() || "";
    const devices: string[] = [];
    const lines = output.split("\n");
    let isVideo = false;

    for (const line of lines) {
      if (line.includes("DirectShow video devices")) isVideo = true;
      if (line.includes("DirectShow audio devices")) isVideo = false;
      if (isVideo) {
        const match = line.match(/"([^"]+)"/);
        if (match && !match[1].includes("@device")) {
          devices.push(match[1]);
        }
      }
    }

    return devices;
  }
}

/** Capture a single frame from webcam */
export function captureFrame(options: CaptureOptions = {}): CaptureResult {
  const format = options.format ?? "jpg";
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const quality = options.quality ?? 85;
  const outPath = tmpPath(format);

  // Find device
  let device = options.device;
  if (!device) {
    const devices = listDevices();
    if (devices.length === 0) throw new Error("No video devices found");
    device = devices[0];
  }

  try {
    const args = [
      "-f", "dshow",
      "-i", `video=${device}`,
      "-frames:v", "1",
      "-s", `${width}x${height}`,
    ];

    if (format === "jpg") {
      args.push("-q:v", String(Math.round((100 - quality) * 31 / 100 + 1)));
    }

    args.push("-y", outPath);

    execFileSync("ffmpeg", args, {
      timeout: 10_000,
      stdio: "ignore",
    });

    if (!existsSync(outPath)) throw new Error("Capture failed — no output file");

    const image = readFileSync(outPath);
    return {
      image,
      format,
      width,
      height,
      capturedAt: new Date().toISOString(),
      deviceName: device,
    };
  } finally {
    try { unlinkSync(outPath); } catch {}
  }
}

/** Capture frame and encode as base64 data URI (for sending to vision models) */
export function captureBase64(options: CaptureOptions = {}): {
  dataUri: string;
  capturedAt: string;
} {
  const result = captureFrame({ ...options, format: "jpg" });
  const b64 = result.image.toString("base64");
  return {
    dataUri: `data:image/jpeg;base64,${b64}`,
    capturedAt: result.capturedAt,
  };
}

/** Capture and describe using a vision model API */
export async function captureAndDescribe(
  options: CaptureOptions & {
    prompt?: string;
    apiUrl?: string;
    apiKey?: string;
    model?: string;
  } = {},
): Promise<{ description: string; capturedAt: string }> {
  const { dataUri, capturedAt } = captureBase64(options);
  const prompt = options.prompt ?? "Describe what you see in this image concisely.";
  const apiUrl = options.apiUrl ?? "https://api.anthropic.com/v1/messages";
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  const model = options.model ?? "claude-sonnet-4-20250514";

  if (!apiKey) throw new Error("No API key — set ANTHROPIC_API_KEY");

  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: dataUri.split(",")[1] } },
          { type: "text", text: prompt },
        ],
      }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) throw new Error(`Vision API error: ${resp.status}`);
  const data = await resp.json() as any;
  const description = data.content?.[0]?.text ?? "";

  return { description, capturedAt };
}
