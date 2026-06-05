// Desktop-specific settings persisted to ~/.lax/desktop-settings.json.
// Distinct from LAX server config (config.ts) — these are Electron-only
// concerns (autostart, close-to-tray, global hotkey, window bounds,
// renderer theme mirror).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { LAX_DIR, DESKTOP_SETTINGS_PATH } from "./config";

export interface DesktopSettings {
  autostart: boolean;
  closeToTray: boolean;
  globalHotkey: string;
  windowBounds: { width: number; height: number };
  // Mirrors the renderer's lax_theme so the BrowserWindow paint colour
  // matches the web UI's theme. Renderer toggles push the new value here
  // via IPC.
  theme: "dark" | "light" | "system";
}

const DEFAULT_SETTINGS: DesktopSettings = {
  autostart: false,
  closeToTray: true,
  globalHotkey: "CommandOrControl+Shift+Space",
  windowBounds: { width: 1200, height: 800 },
  theme: "dark",
};

function load(): DesktopSettings {
  try {
    if (existsSync(DESKTOP_SETTINGS_PATH)) {
      const raw = JSON.parse(readFileSync(DESKTOP_SETTINGS_PATH, "utf-8"));
      return { ...DEFAULT_SETTINGS, ...raw };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function save(s: DesktopSettings): void {
  if (!existsSync(LAX_DIR)) mkdirSync(LAX_DIR, { recursive: true });
  writeFileSync(DESKTOP_SETTINGS_PATH, JSON.stringify(s, null, 2), "utf-8");
}

let settings = load();

export function getSetting<K extends keyof DesktopSettings>(key: K): DesktopSettings[K] {
  return settings[key];
}

export function setSetting<K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]): void {
  settings[key] = value;
  save(settings);
}
