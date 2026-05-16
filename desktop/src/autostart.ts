/**
 * Autostart — register/unregister the app to launch on user login.
 * Uses Electron's setLoginItemSettings which handles Windows (Run key),
 * macOS (Login Items), and Linux (autostart .desktop entry) natively.
 */

import { app } from "electron";

export function registerAutostart(): void {
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  console.log("[desktop] Autostart registered");
}

export function unregisterAutostart(): void {
  app.setLoginItemSettings({ openAtLogin: false });
  console.log("[desktop] Autostart unregistered");
}

export function isAutostartEnabled(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}
