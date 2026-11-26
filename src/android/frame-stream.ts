/**
 * The feed behind the app's Android tab (desktop/src/android-view.ts): a
 * device someone is looking at or driving is screenshotted over adb on an
 * interval and each PNG is pushed to the desktop canvas. There is no native
 * Android view to attach — screenshot() is already the chosen capture path
 * (see adb.ts), so "streaming" is calling it on a timer. A continuous-mirror
 * tool (scrcpy) would trade this simplicity for lower latency; not worth it
 * for a testing tool where a few frames a second is plenty.
 *
 * A device is watched on a lease, renewed by whoever has a reason to see it:
 * the agent's `android` tool each time it acts on the device, the emulator
 * start, and the tab while it is open on it. The feed used to start only for
 * an emulator this process booted, so a phone over USB, or an emulator that
 * was already running, never showed in the tab however the agent drove it
 * (2026-11-26). A lease nobody renews runs out and the polling stops: a phone
 * left plugged in is not screenshotted forever.
 */

import { screenshot } from "./adb.js";
import { desktopPushAndroidFrame } from "../desktop-bridge.js";
import { createLogger } from "../logger.js";

const log = createLogger("android.frame-stream");

/** How long one renewal keeps a device's feed running. The tab renews every
 *  few seconds while it is open; the agent on each action. */
export const WATCH_LEASE_MS = 30_000;
const FRAME_INTERVAL_MS = 500;

interface Watch {
  until: number;
  timer: ReturnType<typeof setInterval>;
  inFlight: boolean;
  /** A device that stopped answering is logged once, not twice a second. */
  failing: boolean;
}

const watches = new Map<string, Watch>();

async function captureFrame(serial: string, watch: Watch): Promise<void> {
  if (watch.inFlight) return;
  if (Date.now() >= watch.until) { unwatchDevice(serial); return; }
  watch.inFlight = true;
  try {
    const png = await screenshot(serial);
    watch.failing = false;
    if (watches.get(serial) === watch) desktopPushAndroidFrame(serial, png); // no-op outside the desktop app
  } catch (e) {
    if (!watch.failing) log.warn(`frame capture failed for ${serial}: ${(e as Error).message}`);
    watch.failing = true;
  } finally {
    watch.inFlight = false;
  }
}

/** Show `serial` in the app's Android tab for another lease, starting its
 *  feed if it has none. */
export function watchDevice(serial: string): void {
  const until = Date.now() + WATCH_LEASE_MS;
  const current = watches.get(serial);
  if (current) { current.until = until; return; }
  const watch: Watch = {
    until,
    inFlight: false,
    failing: false,
    timer: setInterval(() => { void captureFrame(serial, watch); }, FRAME_INTERVAL_MS),
  };
  watch.timer.unref?.();
  watches.set(serial, watch);
  void captureFrame(serial, watch);
}

/** Stop `serial`'s feed now: the device is gone. */
export function unwatchDevice(serial: string): void {
  const watch = watches.get(serial);
  if (!watch) return;
  clearInterval(watch.timer);
  watches.delete(serial);
}

/** The devices with a live feed. */
export function watchedDevices(): string[] {
  return [...watches.keys()];
}
