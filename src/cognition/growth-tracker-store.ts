/**
 * Growth Tracker persistence — store types, file I/O, and level utilities.
 *
 * Backs GrowthTracker; persists to ~/.lax/growth-tracker.json.
 */

import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createJsonStore } from "../util/json-store.js";

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

export type TrackerStore = {
  skills: SkillProfile[];
  firsts: { type: string; timestamp: number; sessionId: string }[];
  counters: Record<string, number>;
};

const LAX_DIR = getLaxDir();
const STORE_FILE = join(LAX_DIR, "growth-tracker.json");
const MAX_SKILLS = 200;
const MAX_ENTRIES_PER_SKILL = 100;
const MAX_FIRSTS = 500;

const trackerStore = createJsonStore<TrackerStore>(STORE_FILE, {
  defaults: () => ({ skills: [], firsts: [], counters: {} }),
  caps: { skills: { max: MAX_SKILLS, keep: "head" }, firsts: MAX_FIRSTS },
});

export function loadStore(): TrackerStore {
  return trackerStore.load();
}

export function saveStore(store: TrackerStore): void {
  // Most-recently-seen skills survive the head cap; sort only when over the
  // cap so an under-cap store keeps its existing on-disk order.
  if (store.skills.length > MAX_SKILLS) {
    store.skills.sort((a, b) => b.lastSeen - a.lastSeen);
  }
  // Per-skill entry cap is nested, outside the store's per-key cap model.
  for (const skill of store.skills) {
    if (skill.entries.length > MAX_ENTRIES_PER_SKILL) {
      skill.entries = skill.entries.slice(-MAX_ENTRIES_PER_SKILL);
    }
  }
  trackerStore.save(store);
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
