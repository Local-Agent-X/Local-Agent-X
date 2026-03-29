/**
 * Autostart — register/unregister the app to start on Windows boot.
 * Uses the Windows Registry via reg.exe (no native module needed).
 */

import { execSync } from "child_process";
import { app } from "electron";

const REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APP_NAME = "OpenAgentX";

export function registerAutostart(): void {
  try {
    const exePath = app.getPath("exe");
    execSync(
      `reg add "${REG_KEY}" /v "${APP_NAME}" /t REG_SZ /d "${exePath}" /f`,
      { stdio: "ignore", windowsHide: true }
    );
    console.log("[desktop] Autostart registered");
  } catch (err) {
    console.error("[desktop] Failed to register autostart:", err);
  }
}

export function unregisterAutostart(): void {
  try {
    execSync(`reg delete "${REG_KEY}" /v "${APP_NAME}" /f`, {
      stdio: "ignore",
      windowsHide: true,
    });
    console.log("[desktop] Autostart unregistered");
  } catch {
    // Key might not exist — that's fine
  }
}

export function isAutostartEnabled(): boolean {
  try {
    const result = execSync(`reg query "${REG_KEY}" /v "${APP_NAME}"`, {
      encoding: "utf-8",
      windowsHide: true,
    });
    return result.includes(APP_NAME);
  } catch {
    return false;
  }
}
