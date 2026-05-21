// SAX server connection config + project-root resolution. Read once at
// boot from ~/.lax/config.json and cached. Restart Server menu calls
// reloadSAXConfig() so port/token changes pick up without an Electron
// restart.

import { app } from "electron";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

export const SAX_DIR = join(homedir(), ".lax");
export const CONFIG_PATH = join(SAX_DIR, "config.json");
export const DESKTOP_SETTINGS_PATH = join(SAX_DIR, "desktop-settings.json");

// In packaged mode __dirname is inside app.asar — use config to find the
// live repo. Sentinel is src/index.ts (not dist/index.js) — we run the
// server from src via tsx, so dist may not exist on a fresh install.
export const PROJECT_ROOT = (() => {
  const devRoot = resolve(__dirname, "..", "..");
  if (!app.isPackaged) return devRoot;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (cfg.projectRoot && existsSync(join(cfg.projectRoot, "src", "index.ts"))) {
      return resolve(cfg.projectRoot);
    }
  } catch {}
  return devRoot;
})();

// PNG works for both BrowserWindow + Tray on Windows/Mac/Linux at runtime.
// Platform-specific .ico/.icns are used by electron-builder for the
// packaged installer art, not at runtime.
export const ICON_PATH = join(PROJECT_ROOT, "public", "icon.png");

export interface SAXConfig {
  port: number;
  authToken: string;
}

const DEFAULTS: SAXConfig = { port: 7007, authToken: "" };

let cached: SAXConfig | null = null;

export function loadSAXConfig(): SAXConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return {
        port: raw.port ?? DEFAULTS.port,
        authToken: raw.authToken ?? DEFAULTS.authToken,
      };
    }
  } catch {}
  return { ...DEFAULTS };
}

export function getSAXConfig(): SAXConfig {
  if (!cached) cached = loadSAXConfig();
  return cached;
}

export function reloadSAXConfig(): SAXConfig {
  cached = loadSAXConfig();
  return cached;
}
