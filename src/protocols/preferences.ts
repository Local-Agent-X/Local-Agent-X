import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

export interface ProtocolPreferences {
  [missionName: string]: Record<string, unknown>;
}

const prefsDirNow = (): string => join(getLaxDir(), "protocol-prefs");

export function loadPrefs(): ProtocolPreferences {
  const path = join(prefsDirNow(), "prefs.json");
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf-8")); } catch {}
  }
  return {};
}

export function savePrefs(prefs: ProtocolPreferences): void {
  if (!existsSync(prefsDirNow())) mkdirSync(prefsDirNow(), { recursive: true });
  writeFileSync(join(prefsDirNow(), "prefs.json"), JSON.stringify(prefs, null, 2), "utf-8");
}
