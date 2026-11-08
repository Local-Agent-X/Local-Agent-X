// Global hotkey registration (CommandOrControl+Shift+Space by default —
// surfaces the window from anywhere) and native OS notifications. Both
// are app-wide concerns, not tied to a specific window instance.

import { globalShortcut, Notification, nativeImage } from "electron";
import { existsSync } from "fs";
import { ICON_PATH } from "./config";
import { getSetting } from "./settings";
import { panicAbortServer } from "./server-process";
import { bringToFront } from "./window";

export function registerHotkey(toggleAction: () => void): void {
  const hotkey = getSetting("globalHotkey");
  try {
    globalShortcut.register(hotkey, toggleAction);
    console.log(`[desktop] Global hotkey registered: ${hotkey}`);
  } catch (err) {
    console.error(`[desktop] Failed to register hotkey ${hotkey}:`, err);
  }
}

// The PANIC kill switch — a GLOBAL accelerator so it fires even while the agent
// drives another app's window (you can't reliably click a UI stop button the
// agent is fighting you for). Firing it aborts the run AND disarms computer
// control. Default ⌘/Ctrl+Shift+\; a configurable binding is a later step.
const PANIC_HOTKEY = "CommandOrControl+Shift+\\";

export function registerPanicHotkey(): void {
  try {
    globalShortcut.register(PANIC_HOTKEY, () => {
      console.warn("[desktop] PANIC hotkey — aborting run + disarming computer control");
      panicAbortServer();
      showNotification("Agent stopped", "The panic hotkey aborted the run and turned off computer control.");
    });
    console.log(`[desktop] Panic hotkey registered: ${PANIC_HOTKEY}`);
  } catch (err) {
    console.error(`[desktop] Failed to register panic hotkey ${PANIC_HOTKEY}:`, err);
  }
}

// A shown toast stays referenced until it closes: Electron drops the click
// handler of a Notification that was garbage-collected, so a click on an
// older toast did nothing.
const shown = new Set<Notification>();

/**
 * A native toast. Clicking it brings LAX to the front (restored if minimized)
 * and then runs `onClick`, if given. Returns the toast so its owner can close
 * it, or null where the OS has no notifications.
 */
export function showNotification(title: string, body: string, onClick?: () => void): Notification | null {
  if (!Notification.isSupported()) return null;
  const icon = existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : undefined;
  const toast = new Notification({ title, body, icon });
  shown.add(toast);
  toast.on("click", () => {
    shown.delete(toast);
    bringToFront();
    try { onClick?.(); } catch (e) { console.warn("[desktop] toast click handler failed:", e); }
  });
  toast.on("close", () => { shown.delete(toast); });
  toast.show();
  return toast;
}
