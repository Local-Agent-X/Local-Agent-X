/**
 * Profile store — persists the currently-active autonomy profile name to
 * ~/.lax/autonomy-profile.json. Fresh installs default to "Normal".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { randomBytes } from "node:crypto";

import {
  DEFAULT_PROFILE,
  isProfileName,
  type ProfileName,
} from "./profiles.js";

const LAX_DIR = getLaxDir();
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

// ── Per-session profile overrides ───────────────────────────
// Unattended runs (a cron job marked Autonomous, say) need a profile that
// differs from the global one without rewriting the persisted setting. The
// override is keyed by sessionId and lives in memory only — set when the run
// starts, cleared when it ends. Resolution: a session override wins over the
// persisted global profile (see getToolDecision).
const sessionProfiles = new Map<string, ProfileName>();

export function setSessionProfile(sessionId: string, name: ProfileName): void {
  sessionProfiles.set(sessionId, name);
}

export function clearSessionProfile(sessionId: string): void {
  sessionProfiles.delete(sessionId);
}

export function getSessionProfile(sessionId: string): ProfileName | undefined {
  return sessionProfiles.get(sessionId);
}

/** Copy a parent session's profile override onto a child session, if the
 *  parent has one. Used when spawning a sub-agent so it runs under the same
 *  contract as its (e.g. cron-pinned-to-Autonomous) parent instead of falling
 *  back to the global profile. Captured at spawn time because the spawned run
 *  starts asynchronously — by the time it reads its profile, the parent run
 *  may have already torn its override down. Returns the inherited profile, or
 *  undefined when there was nothing to inherit. */
export function inheritSessionProfile(
  parentSessionId: string | undefined,
  childSessionId: string,
): ProfileName | undefined {
  if (!parentSessionId) return undefined;
  const parent = sessionProfiles.get(parentSessionId);
  if (parent) sessionProfiles.set(childSessionId, parent);
  return parent;
}
