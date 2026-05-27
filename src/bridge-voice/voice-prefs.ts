// Per-chat voice-reply preferences for the Telegram and WhatsApp bridges.
//
// Persisted to ~/.lax/bridge-voice-prefs.json so the toggle survives
// restarts. Default is voice OFF for every chat — the user must opt in via
// "/voice on" before the bridge will TTS replies. The single exception
// (handled by the bridge, not this module) is when the user's incoming
// message was itself a voice note: we mirror the channel for that turn.
//
// Format:
//   { "telegram": { "<chatId>": true, ... },
//     "whatsapp": { "<jid>":     false, ... } }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

import { createLogger } from "../logger.js";
const logger = createLogger("bridge-voice.prefs");

export type BridgePlatform = "telegram" | "whatsapp";

interface PrefsFile {
  telegram?: Record<string, boolean>;
  whatsapp?: Record<string, boolean>;
}

const PREFS_PATH = join(getLaxDir(), "bridge-voice-prefs.json");

let cache: PrefsFile | null = null;

function load(): PrefsFile {
  if (cache) return cache;
  try {
    if (existsSync(PREFS_PATH)) {
      const raw = JSON.parse(readFileSync(PREFS_PATH, "utf-8"));
      cache = {
        telegram: typeof raw.telegram === "object" && raw.telegram !== null ? raw.telegram : {},
        whatsapp: typeof raw.whatsapp === "object" && raw.whatsapp !== null ? raw.whatsapp : {},
      };
    } else {
      cache = { telegram: {}, whatsapp: {} };
    }
  } catch (e) {
    logger.warn(`failed to load prefs: ${(e as Error).message} — starting fresh`);
    cache = { telegram: {}, whatsapp: {} };
  }
  return cache;
}

function save(prefs: PrefsFile): void {
  try {
    mkdirSync(getLaxDir(), { recursive: true });
    writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2));
  } catch (e) {
    logger.error(`failed to save prefs: ${(e as Error).message}`);
  }
}

/** Returns the per-chat voice preference. Default: false (voice off). */
export function getVoicePref(platform: BridgePlatform, chatId: string): boolean {
  const prefs = load();
  const bucket = prefs[platform] || {};
  return bucket[chatId] === true;
}

/** Persists the per-chat voice preference and updates the in-memory cache. */
export function setVoicePref(platform: BridgePlatform, chatId: string, on: boolean): void {
  const prefs = load();
  if (!prefs[platform]) prefs[platform] = {};
  prefs[platform]![chatId] = on;
  save(prefs);
}
