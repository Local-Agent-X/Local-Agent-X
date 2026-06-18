// Global hotkey registration (CommandOrControl+Shift+Space by default —
// surfaces the window from anywhere) and native OS notifications. Both
// are app-wide concerns, not tied to a specific window instance.

import { globalShortcut, Notification, nativeImage } from "electron";
import { existsSync } from "fs";
import { ICON_PATH } from "./config";
import { getSetting } from "./settings";
import { panicAbortServer } from "./server-process";

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

export function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const icon = existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : undefined;
  new Notification({ title, body, icon }).show();
}
