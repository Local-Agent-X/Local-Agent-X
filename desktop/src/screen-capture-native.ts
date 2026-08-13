// Screen capture performed in the Electron MAIN process, on the server child's
// behalf. This exists for one macOS-specific reason:
//
//   The desktop app spawns its server as a standalone Node binary living
//   OUTSIDE the .app bundle (native-addon ABI — see server-process.ts). macOS
//   attributes a screen-recording check to the process that runs the capture,
//   and that Node runtime is NOT the granted "Local Agent X" app — so a
//   `screencapture` the server spawns itself is denied with "could not create
//   image from display" even though the app's toggle is on. Main IS the granted
//   .app, so a capture here succeeds. The server delegates over the IPC bridge
//   (server-bridge → this module) and gets the bytes back.
//
// desktopCapturer (not the CLI) keeps everything in-process: crop/resize/encode
// via NativeImage, no temp files, no second helper to grant. The grant that
// covers this survives OTA updates because the .app shell (and its Developer-ID
// signature) is never replaced — only its on-disk JS payload changes.

import { desktopCapturer, screen } from "electron";

export interface NativeCaptureRequest {
  monitor?: number;
  region?: { x: number; y: number; width: number; height: number };
  format?: "png" | "jpg";
  quality?: number;
  scale?: number;
}

export interface NativeCaptureResult {
  ok: boolean;
  imageB64?: string;
  format?: "png" | "jpg";
  width?: number;
  height?: number;
  error?: string;
}

/** Capture the requested display and return an encoded image. Never throws —
 *  failures come back as { ok:false, error } so a bad capture can't take down
 *  the bridge listener; the server falls back to its own CLI path. */
export async function captureScreenInMain(req: NativeCaptureRequest): Promise<NativeCaptureResult> {
  try {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const target = (req.monitor != null && displays[req.monitor]) ? displays[req.monitor] : primary;

    // Request the thumbnail at the display's FULL pixel size (DIP × scaleFactor)
    // so text stays legible for OCR/vision; a default small thumbnail would be
    // unreadable. getSources needs the app's Screen Recording grant — which main
    // holds — otherwise it returns empty/black sources.
    const sf = target.scaleFactor || 1;
    const fullW = Math.max(1, Math.round(target.size.width * sf));
    const fullH = Math.max(1, Math.round(target.size.height * sf));
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: fullW, height: fullH } });
    if (sources.length === 0) {
      return { ok: false, error: "no screen sources returned (Screen Recording permission may be off for Local Agent X)" };
    }

    // Match the source to the target display by id; display_id can be empty on
    // some setups, so fall back to positional index, then to the first source.
    let src = sources.find((s) => s.display_id && String(s.display_id) === String(target.id));
    if (!src) src = (req.monitor != null && sources[req.monitor]) ? sources[req.monitor] : sources[0];

    let img = src.thumbnail;
    if (img.isEmpty()) {
      return { ok: false, error: "captured an empty image (Screen Recording likely denied for the app)" };
    }

    // Region is in points relative to the monitor's top-left (the tool's
    // contract); NativeImage.crop works in device pixels, so scale by sf.
    if (req.region && req.region.width > 0 && req.region.height > 0) {
      img = img.crop({
        x: Math.max(0, Math.round(req.region.x * sf)),
        y: Math.max(0, Math.round(req.region.y * sf)),
        width: Math.max(1, Math.round(req.region.width * sf)),
        height: Math.max(1, Math.round(req.region.height * sf)),
      });
    }

    const scale = Math.min(1, Math.max(0.1, req.scale ?? 1));
    if (scale < 1) {
      const sz = img.getSize();
      img = img.resize({ width: Math.max(1, Math.round(sz.width * scale)), height: Math.max(1, Math.round(sz.height * scale)) });
    }

    const size = img.getSize();
    const format: "png" | "jpg" = req.format === "png" ? "png" : "jpg";
    const buf = format === "png"
      ? img.toPNG()
      : img.toJPEG(Math.min(100, Math.max(1, Math.round(req.quality ?? 80))));

    return { ok: true, imageB64: buf.toString("base64"), format, width: size.width, height: size.height };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
