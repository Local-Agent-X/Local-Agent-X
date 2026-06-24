// Remote-control glue for the live-screen feature: turns the phone's NORMALIZED
// input events (protocol.ts ScreenInputEvent) into real OS mouse/keyboard input
// via the canonical input-driver. One per session, owned by ScreenSession.
//
// It does NOT re-implement injection — it calls input-driver.ts, the same module
// the agent's `computer` tool uses. It only adds what's specific to driving from
// a phone: normalized→absolute mapping against the live monitor, a virtual cursor
// for relative (trackpad) moves, move-coalescing + serialization so a 60 Hz drag
// can't back up behind nut.js's per-action delay, and a per-event enableRemoteControl
// gate so the Settings kill-switch / panic hotkey halt injection mid-session.

import { getRuntimeConfig } from "../config.js";
import { listMonitors } from "../screen-capture.js";
import {
  setMousePosition,
  getMousePosition,
  getScreenSize,
  clickMouse,
  pressButton,
  releaseButton,
  scroll,
  typeText,
  pressKeys,
} from "../tools/input-driver.js";
import type { ScreenInputEvent } from "./protocol.js";
import { createLogger } from "../logger.js";

const logger = createLogger("screen-stream.input");

type Rect = { x: number; y: number; width: number; height: number };

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

const FALLBACK_RECT: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

/** The desktop rect that normalized phone input is mapped onto. It MUST be the
 *  same coordinate space the injector (input-driver → nut.js) writes into, or
 *  every tap lands off-target.
 *
 *  Windows: listMonitors() is real (PowerShell System.Windows.Forms), so use it
 *  — it carries a monitor index and virtual-desktop origins for multi-monitor.
 *
 *  macOS/Linux: listMonitors() has NO native implementation and falls back to a
 *  bogus 1920x1080. Mapping onto that and then injecting into nut.js's real
 *  point space scaled every tap down-and-right (a 1408x881 screen reported as
 *  1920x1080 → x*1.36, y*1.23). Take the size straight from nut.js instead — it
 *  is exactly the space setMousePosition uses, and avfoundation captures the
 *  primary screen, so a monitor index doesn't apply here. */
async function resolveMonitorRect(monitor?: number): Promise<Rect> {
  if (process.platform === "win32") {
    const mons = listMonitors();
    const m = (monitor != null ? mons[monitor] : undefined) ?? mons.find((x) => x.primary) ?? mons[0];
    return m ? { x: m.x, y: m.y, width: m.width, height: m.height } : FALLBACK_RECT;
  }
  try {
    const { width, height } = await getScreenSize();
    if (width > 0 && height > 0) return { x: 0, y: 0, width, height };
  } catch {
    /* nut.js unavailable (no accessibility grant) — fall back below */
  }
  return FALLBACK_RECT;
}

/** Monitor count, active index, and the active monitor's pixel size — the
 *  rtc_displays payload (count → swipe affordance; size → phone letterbox math). */
export async function describeDisplays(activeMonitor?: number): Promise<{
  count: number;
  active: number;
  width: number;
  height: number;
}> {
  // Windows: enumerate real monitors so the phone can offer swipe-between-screens.
  if (process.platform === "win32") {
    const mons = listMonitors();
    const count = Math.max(1, mons.length);
    const primaryIdx = mons.findIndex((m) => m.primary);
    const active =
      activeMonitor != null && activeMonitor >= 0 && activeMonitor < count
        ? activeMonitor
        : primaryIdx >= 0
          ? primaryIdx
          : 0;
    const rect = await resolveMonitorRect(active);
    return { count, active, width: rect.width, height: rect.height };
  }
  // macOS/Linux: a single capturable screen (avfoundation primary). Report its
  // REAL size so the phone's letterbox math matches the video's true aspect.
  const rect = await resolveMonitorRect(activeMonitor);
  return { count: 1, active: 0, width: rect.width, height: rect.height };
}

export class ScreenInputController {
  /** Desktop rect normalized input maps onto. Resolved lazily on first use
   *  (async — nut.js on macOS) and cached until the monitor changes. */
  private rect: Rect | null = null;
  private monitor: number | undefined;
  /** Virtual cursor in absolute desktop px — seeded from the real cursor lazily. */
  private cursor: { x: number; y: number } | null = null;
  private queue: ScreenInputEvent[] = [];
  private pumping = false;
  private errorSent = false;

  constructor(
    monitor: number | undefined,
    private readonly onError: (message: string) => void,
  ) {
    this.monitor = monitor;
  }

  /** Re-target after a monitor switch (re-resolve the rect + re-seed the cursor). */
  setMonitor(monitor: number | undefined): void {
    this.monitor = monitor;
    this.rect = null;
    this.cursor = null;
  }

  private async ensureRect(): Promise<Rect> {
    if (!this.rect) this.rect = await resolveMonitorRect(this.monitor);
    return this.rect;
  }

  enqueue(event: ScreenInputEvent): void {
    const last = this.queue[this.queue.length - 1];
    // Coalesce adjacent moves so a fast drag can't outrun injection: sum relative
    // nudges; keep only the latest absolute target.
    if (last && last.kind === "moveBy" && event.kind === "moveBy") {
      last.dx += event.dx;
      last.dy += event.dy;
    } else if (last && last.kind === "move" && event.kind === "move") {
      last.x = event.x;
      last.y = event.y;
    } else {
      this.queue.push(event);
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        if (!getRuntimeConfig().enableRemoteControl) {
          this.queue = []; // disarmed mid-session (Settings toggle / panic) — drop everything
          return;
        }
        const ev = this.queue.shift() as ScreenInputEvent;
        try {
          await this.apply(ev);
        } catch (e) {
          this.reportOnce((e as Error).message);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async ensureCursor(): Promise<{ x: number; y: number }> {
    if (!this.cursor) this.cursor = await getMousePosition();
    return this.cursor;
  }

  private async apply(ev: ScreenInputEvent): Promise<void> {
    switch (ev.kind) {
      case "move": {
        const rect = await this.ensureRect();
        const x = rect.x + clamp(ev.x, 0, 1) * rect.width;
        const y = rect.y + clamp(ev.y, 0, 1) * rect.height;
        this.cursor = { x, y };
        await setMousePosition(x, y);
        break;
      }
      case "moveBy": {
        const rect = await this.ensureRect();
        const c = await this.ensureCursor();
        const x = clamp(c.x + ev.dx * rect.width, rect.x, rect.x + rect.width);
        const y = clamp(c.y + ev.dy * rect.height, rect.y, rect.y + rect.height);
        this.cursor = { x, y };
        await setMousePosition(x, y);
        break;
      }
      case "click":
        await clickMouse({ button: ev.button, double: ev.double });
        break;
      case "down":
        await pressButton(ev.button ?? "left");
        break;
      case "up":
        await releaseButton(ev.button ?? "left");
        break;
      case "scroll":
        await scroll(Math.round(ev.dx), Math.round(ev.dy));
        break;
      case "text":
        await typeText(ev.text);
        break;
      case "key":
        await pressKeys(ev.keys);
        break;
    }
  }

  /** Surface the first failure (usually the macOS Accessibility grant) to the
   *  phone once — a stream of moves must not spam rtc_error frames. */
  private reportOnce(message: string): void {
    if (this.errorSent) return;
    this.errorSent = true;
    logger.warn(`[screen-input] injection failed: ${message}`);
    this.onError(message);
  }
}
