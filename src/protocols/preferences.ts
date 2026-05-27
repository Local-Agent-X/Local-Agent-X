import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

export interface ProtocolPreferences {
  [missionName: string]: Record<string, unknown>;
}

const prefsDir = join(getLaxDir(), "protocol-prefs");

export function loadPrefs(): ProtocolPreferences {
  const path = join(prefsDir, "prefs.json");
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf-8")); } catch {}
  }
  return {};
}

export function savePrefs(prefs: ProtocolPreferences): void {
  if (!existsSync(prefsDir)) mkdirSync(prefsDir, { recursive: true });
  writeFileSync(join(prefsDir, "prefs.json"), JSON.stringify(prefs, null, 2), "utf-8");
}
