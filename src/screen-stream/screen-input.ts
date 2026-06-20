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

function monitorRect(monitor?: number): Rect {
  const mons = listMonitors();
  const m = (monitor != null ? mons[monitor] : undefined) ?? mons.find((x) => x.primary) ?? mons[0];
  return m ? { x: m.x, y: m.y, width: m.width, height: m.height } : { x: 0, y: 0, width: 1920, height: 1080 };
}

/** Monitor count, active index, and the active monitor's pixel size — the
 *  rtc_displays payload (count → swipe affordance; size → phone letterbox math). */
export function describeDisplays(activeMonitor?: number): {
  count: number;
  active: number;
  width: number;
  height: number;
} {
  const mons = listMonitors();
  const count = Math.max(1, mons.length);
  const primaryIdx = mons.findIndex((m) => m.primary);
  const active =
    activeMonitor != null && activeMonitor >= 0 && activeMonitor < count
      ? activeMonitor
      : primaryIdx >= 0
        ? primaryIdx
        : 0;
  const rect = monitorRect(active);
  return { count, active, width: rect.width, height: rect.height };
}

export class ScreenInputController {
  private rect: Rect;
  /** Virtual cursor in absolute desktop px — seeded from the real cursor lazily. */
  private cursor: { x: number; y: number } | null = null;
  private queue: ScreenInputEvent[] = [];
  private pumping = false;
  private errorSent = false;

  constructor(
    monitor: number | undefined,
    private readonly onError: (message: string) => void,
  ) {
    this.rect = monitorRect(monitor);
  }

  /** Re-target after a monitor switch (re-seed the cursor against the new rect). */
  setMonitor(monitor: number | undefined): void {
    this.rect = monitorRect(monitor);
    this.cursor = null;
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
        const x = this.rect.x + clamp(ev.x, 0, 1) * this.rect.width;
        const y = this.rect.y + clamp(ev.y, 0, 1) * this.rect.height;
        this.cursor = { x, y };
        await setMousePosition(x, y);
        break;
      }
      case "moveBy": {
        const c = await this.ensureCursor();
        const x = clamp(c.x + ev.dx * this.rect.width, this.rect.x, this.rect.x + this.rect.width);
        const y = clamp(c.y + ev.dy * this.rect.height, this.rect.y, this.rect.y + this.rect.height);
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
