/**
 * Browser profiles — named, persistent browsing identities with saved logins.
 *
 * A profile resolves to two physical stores, one per backend, keyed by the same
 * profile id:
 *   - Electron partition `persist:lax-profile-<id>` (in-app WebContentsView)
 *   - CDP `userDataDir` (external Chrome fallback)
 * Same profileId, two backends — that symmetry is what lets a repeat-task agent
 * stay logged in whether it drives the embedded view or the CDP fallback.
 *
 * JSON singleton at ~/.lax/browser-profiles.json, mirroring the other config
 * entity stores (AgentTemplateStore, ProjectRosterStore). A "default" profile is
 * seeded on first run so an unassigned session always resolves to a real record.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";
import { trashRecord } from "../safe-delete.js";

const logger = createLogger("browser-profiles");

const PROFILES_FILE = join(getLaxDir(), "browser-profiles.json");
/** Parent dir for each profile's CDP userDataDir twin. */
const PROFILES_DATA_DIR = join(getLaxDir(), "browser-profiles");

export const DEFAULT_PROFILE_ID = "default";

export interface BrowserProfile {
  id: string;
  name: string;
  /** Electron session partition (in-app backend). */
  partition: string;
  /** CDP userDataDir twin (external-Chrome fallback backend). */
  userDataDir: string;
  createdAt: number;
  lastUsedAt: number;
  notes?: string;
}

/** Partition string for a profile id — the single formula both backends key on. */
export function profilePartition(id: string): string {
  return `persist:lax-profile-${id}`;
}

/** CDP userDataDir for a profile id. */
export function profileUserDataDir(id: string): string {
  return join(PROFILES_DATA_DIR, id);
}

export class BrowserProfileStore {
  private static instance: BrowserProfileStore | null = null;
  private profiles: BrowserProfile[] = [];

  private constructor() { this.load(); this.seedDefault(); }

  static getInstance(): BrowserProfileStore {
    if (!BrowserProfileStore.instance) BrowserProfileStore.instance = new BrowserProfileStore();
    return BrowserProfileStore.instance;
  }

  /** Test-only: reset the singleton so fixtures don't bleed between cases. */
  static _resetForTest(): void {
    BrowserProfileStore.instance = null;
  }

  private load(): void {
    try {
      if (existsSync(PROFILES_FILE)) {
        this.profiles = JSON.parse(readFileSync(PROFILES_FILE, "utf-8"));
      }
    } catch { this.profiles = []; }
  }

  private persist(): void {
    writeFileSync(PROFILES_FILE, JSON.stringify(this.profiles, null, 2), "utf-8");
  }

  /** Seed the built-in "default" profile on first run. Idempotent. */
  private seedDefault(): void {
    if (this.profiles.some((p) => p.id === DEFAULT_PROFILE_ID)) return;
    const now = Date.now();
    this.profiles.unshift({
      id: DEFAULT_PROFILE_ID,
      name: "Default",
      partition: profilePartition(DEFAULT_PROFILE_ID),
      userDataDir: profileUserDataDir(DEFAULT_PROFILE_ID),
      createdAt: now,
      lastUsedAt: now,
    });
    this.persist();
    logger.info("[browser-profiles] Seeded default profile");
  }

  list(): BrowserProfile[] {
    return [...this.profiles].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  get(id: string): BrowserProfile | null {
    return this.profiles.find((p) => p.id === id) || null;
  }

  /** Case-insensitive, trimmed lookup — enforces one profile per display name. */
  findByName(name: string): BrowserProfile | null {
    const target = name.trim().toLowerCase();
    if (!target) return null;
    return this.profiles.find((p) => p.name.trim().toLowerCase() === target) || null;
  }

  create(input: { name: string; notes?: string }): BrowserProfile {
    const name = input.name.trim();
    if (!name) throw new Error("Profile name is required");
    const existing = this.findByName(name);
    if (existing) {
      const err = new Error(`Browser profile '${name}' already exists (id: ${existing.id})`) as Error & { code?: string; existingId?: string };
      err.code = "PROFILE_NAME_EXISTS";
      err.existingId = existing.id;
      throw err;
    }
    const id = "prof-" + Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
    const now = Date.now();
    const profile: BrowserProfile = {
      id,
      name,
      partition: profilePartition(id),
      userDataDir: profileUserDataDir(id),
      createdAt: now,
      lastUsedAt: now,
      notes: input.notes,
    };
    this.profiles.push(profile);
    this.persist();
    return profile;
  }

  /** Patch mutable fields. `partition`/`userDataDir`/`id` are derived and never
   *  rewritten — a rename keeps the same physical stores (and logins). */
  update(id: string, patch: { name?: string; notes?: string; lastUsedAt?: number }): BrowserProfile | null {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const next = { ...this.profiles[idx] };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("Profile name cannot be empty");
      const clash = this.findByName(name);
      if (clash && clash.id !== id) {
        const err = new Error(`Browser profile '${name}' already exists (id: ${clash.id})`) as Error & { code?: string };
        err.code = "PROFILE_NAME_EXISTS";
        throw err;
      }
      next.name = name;
    }
    if (patch.notes !== undefined) next.notes = patch.notes;
    if (patch.lastUsedAt !== undefined) next.lastUsedAt = patch.lastUsedAt;
    this.profiles[idx] = next;
    this.persist();
    return next;
  }

  /** Stamp a profile as recently driven. Best-effort; unknown id is a no-op. */
  touch(id: string): void {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) return;
    p.lastUsedAt = Date.now();
    this.persist();
  }

  /** Delete a profile. The built-in "default" profile can't be removed. Returns
   *  false when the id is unknown or protected. The on-disk partition/userDataDir
   *  (saved logins) are left on disk — callers clear those explicitly. */
  delete(id: string): boolean {
    if (id === DEFAULT_PROFILE_ID) return false;
    const removed = this.profiles.find((p) => p.id === id);
    if (!removed) return false;
    this.profiles = this.profiles.filter((p) => p.id !== id);
    trashRecord(`browser-profile-${id}`, removed);
    this.persist();
    return true;
  }
}
