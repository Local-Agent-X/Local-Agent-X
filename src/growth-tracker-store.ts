/**
 * Growth Tracker persistence — store types, file I/O, and level utilities.
 *
 * Backs GrowthTracker; persists to ~/.lax/growth-tracker.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getLaxDir } from "./lax-data-dir.js";

export type SkillLevel = "beginner" | "intermediate" | "advanced" | "expert";

export interface GrowthEntry {
  skill: string;
  level: SkillLevel;
  evidence: string;
  timestamp: number;
  sessionId: string;
}

export interface SkillProfile {
  name: string;
  currentLevel: SkillLevel;
  entries: GrowthEntry[];
  firstSeen: number;
  lastSeen: number;
}

export interface TrackerStore {
  skills: SkillProfile[];
  firsts: { type: string; timestamp: number; sessionId: string }[];
  counters: Record<string, number>;
}

const LAX_DIR = getLaxDir();
const STORE_FILE = join(LAX_DIR, "growth-tracker.json");
const MAX_SKILLS = 200;
const MAX_ENTRIES_PER_SKILL = 100;
const MAX_FIRSTS = 500;

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

export function loadStore(): TrackerStore {
  if (!existsSync(STORE_FILE)) return { skills: [], firsts: [], counters: {} };
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      firsts: Array.isArray(parsed.firsts) ? parsed.firsts : [],
      counters: parsed.counters && typeof parsed.counters === "object" ? parsed.counters : {},
    };
  } catch {
    return { skills: [], firsts: [], counters: {} };
  }
}

export function saveStore(store: TrackerStore): void {
  ensureDir();
  if (store.skills.length > MAX_SKILLS) {
    store.skills.sort((a, b) => b.lastSeen - a.lastSeen);
    store.skills = store.skills.slice(0, MAX_SKILLS);
  }
  for (const skill of store.skills) {
    if (skill.entries.length > MAX_ENTRIES_PER_SKILL) {
      skill.entries = skill.entries.slice(-MAX_ENTRIES_PER_SKILL);
    }
  }
  if (store.firsts.length > MAX_FIRSTS) {
    store.firsts = store.firsts.slice(-MAX_FIRSTS);
  }
  atomicWrite(STORE_FILE, JSON.stringify(store, null, 2));
}

export const LEVEL_ORDER: Record<SkillLevel, number> = {
  beginner: 0,
  intermediate: 1,
  advanced: 2,
  expert: 3,
};

export const LEVEL_LABELS: SkillLevel[] = ["beginner", "intermediate", "advanced", "expert"];

export function levelName(level: SkillLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}
