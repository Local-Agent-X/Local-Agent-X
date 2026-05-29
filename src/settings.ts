/**
 * Canonical loader/writer for ~/.lax/settings.json.
 *
 * Mirrors src/config.ts's cached-singleton pattern (load once, mutate in
 * memory, atomic write back). settings.json is a flat untyped bag of
 * UI-defined fields — see settings-schema.ts for the FLIPPABLE field list,
 * but this module returns Record<string, unknown> because callers also
 * stuff sidebar pins, custom-page metadata, threat-engine tunables, etc.
 *
 * Existed for years as inline existsSync/readFileSync/JSON.parse at ~13
 * call sites. Centralized so a malformed file fails once (and logs once)
 * instead of N times, and so writes go through atomicWriteFileSync.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { atomicWriteFileSync } from "./server-utils.js";
import { createLogger } from "./logger.js";

const logger = createLogger("settings");

let _cache: Record<string, unknown> | null = null;

export function settingsPath(): string {
  return join(getLaxDir(), "settings.json");
}

function readFromDisk(): Record<string, unknown> {
  const path = settingsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    logger.warn(`[settings] ${path} is not a JSON object, ignoring`);
    return {};
  } catch {
    logger.warn(`[settings] Failed to parse ${path}, using empty object`);
    return {};
  }
}

export function loadSettings(): Record<string, unknown> {
  if (_cache) return _cache;
  _cache = readFromDisk();
  return _cache;
}

export function reloadSettings(): Record<string, unknown> {
  _cache = readFromDisk();
  return _cache;
}

export function getSetting<T = unknown>(key: string): T | undefined {
  return loadSettings()[key] as T | undefined;
}

export function saveSettings(settings: Record<string, unknown>): void {
  atomicWriteFileSync(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  _cache = settings;
}

export function setSetting(key: string, value: unknown): void {
  const next = { ...loadSettings(), [key]: value };
  saveSettings(next);
}
