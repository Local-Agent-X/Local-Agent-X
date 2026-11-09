/**
 * Off-screen browsing: a session whose user is away from the desktop (the
 * phone app, a call on the phone, a messaging bridge) drives its browser views
 * without ever surfacing them in the desktop's Browser pane, and its views are
 * closed once the session stops using them.
 *
 * Owner's call (2026-11-09): a search asked from the phone must not leave a
 * browser open in LAX on the desktop. The views themselves are the same
 * in-app views as ever (created detached, desktop/src/browser-views.ts), so a
 * site sees the same browser either way; only surfacing and lifetime differ.
 *
 * The mark is per browser session (resolveBrowserSessionId), so a sub-agent's
 * browsing follows its parent's. Each turn re-marks its session from where the
 * turn came from, so the same thread typed at the desktop surfaces again.
 */
import type { ChannelId, VoiceDevice } from "../channel-context.js";
import { resolveBrowserSessionId } from "./session-owner-registry.js";

/** How long an off-screen session's browser may sit unused before it closes. */
export const OFF_SCREEN_IDLE_CLOSE_MS = 10 * 60_000;

const offScreen = new Set<string>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Is the user of a turn on this channel away from the desktop's screen?
 *  undefined for a channel with no user watching either way (cron, agent, api),
 *  which leaves the session's mark as it was. */
export function awayFromDesktop(channel: ChannelId | undefined, voiceDevice?: VoiceDevice): boolean | undefined {
  switch (channel) {
    case "mobile": case "telegram": case "whatsapp": return true;
    case "voice": return voiceDevice === "phone";
    case "web": case "cli": return false;
    default: return undefined;
  }
}

/** Mark a session's browsing from where its latest turn came from. */
export function noteBrowserSurface(sessionId: string, channel: ChannelId | undefined, voiceDevice?: VoiceDevice): void {
  const away = awayFromDesktop(channel, voiceDevice);
  if (away === undefined) return;
  const key = resolveBrowserSessionId(sessionId);
  if (away) {
    offScreen.add(key);
  } else {
    offScreen.delete(key);
    clearIdleTimer(key);
  }
}

/** Mark a browser session off screen directly (a one-off hidden lookup). */
export function markBrowserOffScreen(sessionId: string): void {
  offScreen.add(resolveBrowserSessionId(sessionId));
}

export function isBrowserOffScreen(sessionId: string | undefined): boolean {
  return sessionId !== undefined && offScreen.has(resolveBrowserSessionId(sessionId));
}

/** The session used its browser: (re)start its idle close when off screen. */
export function touchOffScreenBrowser(sessionId: string, close: (sessionId: string) => Promise<void>): void {
  const key = resolveBrowserSessionId(sessionId);
  if (!offScreen.has(key)) return;
  clearIdleTimer(key);
  const timer = setTimeout(() => {
    idleTimers.delete(key);
    close(key).catch(() => { /* already closed */ });
  }, OFF_SCREEN_IDLE_CLOSE_MS);
  timer.unref?.();
  idleTimers.set(key, timer);
}

/** The session's browser closed: nothing left to time out. */
export function forgetOffScreenBrowser(sessionId: string): void {
  const key = resolveBrowserSessionId(sessionId);
  clearIdleTimer(key);
}

function clearIdleTimer(key: string): void {
  const timer = idleTimers.get(key);
  if (timer) clearTimeout(timer);
  idleTimers.delete(key);
}

export function _resetOffScreenSessions(): void {
  for (const timer of idleTimers.values()) clearTimeout(timer);
  idleTimers.clear();
  offScreen.clear();
}
