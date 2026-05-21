/**
 * Profile store — persists the currently-active autonomy profile name to
 * ~/.lax/autonomy-profile.json. Fresh installs default to "Normal".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

import {
  DEFAULT_PROFILE,
  isProfileName,
  type ProfileName,
} from "./profiles.js";

const LAX_DIR = join(homedir(), ".lax");
const STORE_FILE = join(LAX_DIR, "autonomy-profile.json");

interface StoredState {
  profile: ProfileName;
}

function ensureDir(): void {
  if (!existsSync(LAX_DIR)) mkdirSync(LAX_DIR, { recursive: true });
}

function atomicWrite(path: string, data: string): void {
  const tmp = path + ".tmp." + randomBytes(4).toString("hex");
  try {
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function loadProfileName(): ProfileName {
  if (!existsSync(STORE_FILE)) return DEFAULT_PROFILE;
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "profile" in parsed) {
      const v = (parsed as { profile: unknown }).profile;
      if (isProfileName(v)) return v;
    }
  } catch {
    // Corrupt or unreadable — fall through to default. A broken store
    // shouldn't lock the user out of the agent.
  }
  return DEFAULT_PROFILE;
}

export function saveProfileName(name: ProfileName): void {
  ensureDir();
  const state: StoredState = { profile: name };
  atomicWrite(STORE_FILE, JSON.stringify(state, null, 2));
}

export const PROFILE_STORE_PATH = STORE_FILE;
