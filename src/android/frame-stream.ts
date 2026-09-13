/**
 * Polling frame source for the desktop canvas sink (desktop/src/android-view.ts).
 * There is no native Android view to attach — screenshot() over adb is already
 * the chosen capture path (see adb.ts), so "streaming" here is just calling it
 * on an interval and handing the PNG bytes to a callback. A continuous-mirror
 * tool (scrcpy) would trade this simplicity for lower latency; not worth it
 * for a testing tool where a few frames/sec is plenty.
 */

import { screenshot } from "./adb.js";
import { desktopPushAndroidFrame } from "../desktop-bridge.js";
import { createLogger } from "../logger.js";

const log = createLogger("android.frame-stream");

export interface FrameStreamHandle {
  stop(): void;
}

export function startFrameStream(
  serial: string,
  onFrame: (png: Buffer) => void,
  intervalMs = 500,
): FrameStreamHandle {
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const png = await screenshot(serial);
      if (!stopped) {
        onFrame(png);
        desktopPushAndroidFrame(serial, png); // no-op outside the desktop app
      }
    } catch (e) {
      log.warn(`frame capture failed for ${serial}: ${(e as Error).message}`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  void tick();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
