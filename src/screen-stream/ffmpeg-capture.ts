// ffmpeg gdigrab → VP8 RTP capture pipeline for the live-screen feature.
//
// Reuses LAX's canonical screen-capture approach: ffmpeg gdigrab, NOT a
// PowerShell System.Drawing script (which Defender's AMSI blocks as a
// screen-grabber signature). See src/screen-capture.ts:50-54 + :111-120 for the
// single-frame gdigrab args this continuous pipeline is modeled on, and
// listMonitors() there for the capture-rectangle resolution we reuse.
//
// Difference from the screenshot path: instead of `-frames:v 1 → image2pipe`,
// we encode a continuous VP8 stream and packetize it as RTP over a loopback UDP
// port. A small UDP reader hands each datagram to the werift track via writeRtp.
// This keeps the WebRTC peer free of any ffmpeg/codec knowledge (peer.ts) and the
// capture free of any signaling knowledge — one responsibility per file.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { listMonitors } from "../screen-capture.js";
import { createLogger } from "../logger.js";

const logger = createLogger("screen-stream.ffmpeg");
const FFMPEG = process.env.LAX_FFMPEG || "ffmpeg";

/** VP8 payload type / clock the offer advertises (must match the peer codec). */
export const VP8_PAYLOAD_TYPE = 96;
export const VP8_CLOCK_RATE = 90000;

export interface CaptureOptions {
  /** Monitor index to capture; defaults to the primary monitor. */
  monitor?: number;
  /** Capture framerate (fps). Prototype default keeps CPU sane. */
  fps?: number;
  /** Loopback UDP port ffmpeg sends RTP to (the reader binds it). */
  rtpPort: number;
}

export interface CaptureHandle {
  /** Stop ffmpeg + close the UDP reader. Idempotent. */
  stop(): void;
}

/** Resolve the capture rectangle for a monitor index (reuses listMonitors). */
function resolveTarget(monitor?: number): { x: number; y: number; width: number; height: number } {
  const monitors = listMonitors();
  if (monitor != null) {
    const m = monitors[monitor];
    if (m) return { x: m.x, y: m.y, width: m.width, height: m.height };
  }
  const primary = monitors.find((m) => m.primary) ?? monitors[0];
  return primary
    ? { x: primary.x, y: primary.y, width: primary.width, height: primary.height }
    : { x: 0, y: 0, width: 1920, height: 1080 };
}

// VP8 realtime encode → RTP tail, shared by every platform's capture input.
// -deadline realtime + -cpu-used keep latency low; the even width/height filter
// avoids encoder errors on odd-dimension screens.
function encodeRtpArgs(rtpPort: number): string[] {
  return [
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-pix_fmt", "yuv420p",
    "-c:v", "libvpx",
    "-deadline", "realtime",
    "-cpu-used", "5",
    "-b:v", "2M",
    "-payload_type", String(VP8_PAYLOAD_TYPE),
    "-f", "rtp", `rtp://127.0.0.1:${rtpPort}`,
  ];
}

/** Windows: gdigrab region capture → VP8/RTP. */
export function buildFfmpegArgs(target: { x: number; y: number; width: number; height: number }, fps: number, rtpPort: number): string[] {
  return [
    "-hide_banner", "-loglevel", "error",
    "-f", "gdigrab",
    "-framerate", String(fps),
    "-offset_x", String(Math.round(target.x)),
    "-offset_y", String(Math.round(target.y)),
    "-video_size", `${Math.round(target.width)}x${Math.round(target.height)}`,
    "-i", "desktop",
    ...encodeRtpArgs(rtpPort),
  ];
}

/** macOS: avfoundation whole-screen capture → VP8/RTP. Captures the full screen
 *  device (no region crop). Output `-r` sets the frame rate so we don't have to
 *  match an avfoundation-supported input framerate (which it often rejects). */
export function buildMacFfmpegArgs(screenIndex: string, fps: number, rtpPort: number): string[] {
  return [
    "-hide_banner", "-loglevel", "error",
    "-f", "avfoundation",
    "-capture_cursor", "1",
    // Pin the INPUT format: the avfoundation screen device offers uyvy422/yuyv422/
    // nv12/0rgb/bgr0 but NOT yuv420p, and without this ffmpeg defaults the input to
    // yuv420p (what the VP8 encoder wants) — the device rejects it and nothing
    // captures (black stream). encodeRtpArgs converts uyvy422 → yuv420p for VP8.
    "-pixel_format", "uyvy422",
    "-i", `${screenIndex}:none`,
    "-r", String(fps),
    ...encodeRtpArgs(rtpPort),
  ];
}

const IS_MAC = process.platform === "darwin";

/** Cached avfoundation "Capture screen" device index (macOS). */
let cachedScreenIndex: string | null = null;

/**
 * Discover the avfoundation screen-capture device index (macOS). avfoundation
 * lists devices to stderr and exits with an error in list mode — we parse the
 * "[N] Capture screen 0" line. Cached; LAX_AVF_SCREEN_INDEX overrides; falls
 * back to "1" (device 0 is usually the camera).
 */
async function avfScreenIndex(): Promise<string> {
  const override = process.env.LAX_AVF_SCREEN_INDEX;
  if (override) return override;
  if (cachedScreenIndex) return cachedScreenIndex;
  cachedScreenIndex = await new Promise<string>((resolve) => {
    let out = "";
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(FFMPEG, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    } catch {
      resolve("1");
      return;
    }
    proc.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("error", () => resolve("1"));
    proc.on("exit", () => {
      const m = out.match(/\[(\d+)\]\s+Capture screen/);
      resolve(m ? m[1] : "1");
    });
  });
  return cachedScreenIndex;
}

/**
 * Start the capture pipeline. ffmpeg streams VP8 RTP to a loopback UDP port; the
 * bound reader forwards every datagram to `onRtp` (which the peer writes to the
 * track). Errors surface via `onError` so the session can fail cleanly — never a
 * silent stall (constitution §12).
 */
export function startCapture(
  options: CaptureOptions,
  onRtp: (packet: Buffer) => void,
  onError: (message: string) => void,
): CaptureHandle {
  const fps = options.fps ?? 15;

  const sock: Socket = createSocket("udp4");
  let proc: ChildProcessWithoutNullStreams | null = null;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      proc?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    proc = null;
    try {
      sock.close();
    } catch {
      /* already closed */
    }
  };

  sock.on("message", (msg) => {
    if (stopped) return;
    try {
      onRtp(msg);
    } catch (e) {
      logger.warn(`[screen-stream] onRtp threw: ${(e as Error).message}`);
    }
  });
  sock.on("error", (e) => {
    if (stopped) return;
    onError(`Screen RTP socket error: ${e.message}`);
    stop();
  });

  const launch = async (): Promise<void> => {
    if (stopped) return;
    let args: string[];
    try {
      args = IS_MAC
        ? buildMacFfmpegArgs(await avfScreenIndex(), fps, options.rtpPort)
        : buildFfmpegArgs(resolveTarget(options.monitor), fps, options.rtpPort);
    } catch (e) {
      onError(`Failed to resolve the screen to capture: ${(e as Error).message}`);
      stop();
      return;
    }
    if (stopped) return;
    try {
      proc = spawn(FFMPEG, args, { windowsHide: true });
    } catch (e) {
      onError(`Failed to start screen capture: ${(e as Error).message}`);
      stop();
      return;
    }
    proc.stderr.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) logger.warn(`[screen-stream] ffmpeg: ${line.slice(0, 200)}`);
    });
    proc.on("error", (e) => {
      if (stopped) return;
      onError(`Screen capture process error: ${e.message}`);
      stop();
    });
    proc.on("exit", (code) => {
      if (stopped) return;
      // A non-zero exit before stop() means capture died — surface it.
      if (code !== 0 && code !== null) {
        onError(IS_MAC
          ? `Screen capture failed (ffmpeg exit ${code}). On macOS, grant Screen Recording to Local Agent X in System Settings → Privacy & Security → Screen Recording, then retry.`
          : `Screen capture ended unexpectedly (ffmpeg exit ${code}).`);
      }
      stop();
    });
  };

  sock.bind(options.rtpPort, "127.0.0.1", () => {
    if (stopped) return;
    void launch();
  });

  return { stop };
}
