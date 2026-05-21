// Global hotkey registration (CommandOrControl+Shift+Space by default —
// surfaces the window from anywhere) and native OS notifications. Both
// are app-wide concerns, not tied to a specific window instance.

import { globalShortcut, Notification, nativeImage } from "electron";
import { existsSync } from "fs";
import { ICON_PATH } from "./config";
import { getSetting } from "./settings";

export function registerHotkey(toggleAction: () => void): void {
  const hotkey = getSetting("globalHotkey");
  try {
    globalShortcut.register(hotkey, toggleAction);
    console.log(`[desktop] Global hotkey registered: ${hotkey}`);
  } catch (err) {
    console.error(`[desktop] Failed to register hotkey ${hotkey}:`, err);
  }
}

export function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const icon = existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : undefined;
  new Notification({ title, body, icon }).show();
}
