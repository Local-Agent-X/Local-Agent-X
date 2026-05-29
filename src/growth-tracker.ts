/**
 * Growth Tracker — track and celebrate user evolution.
 *
 * Observes skill progression over time, detects milestones, and builds
 * a timeline of growth. Can summarize how the user has evolved and
 * compare different time periods.
 *
 * Persists to ~/.lax/growth-tracker.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getLaxDir } from "./lax-data-dir.js";
import type { ModuleSignal } from "./orchestrator/types.js";

// ── Types ────────────────────────────────────────────────────

export type SkillLevel = "beginner" | "intermediate" | "advanced" | "expert";

export interface GrowthEntry {
  skill: string;
  level: SkillLevel;
  evidence: string;
  timestamp: number;
  sessionId: string;
}

export interface Milestone {
  type: "first" | "count" | "streak" | "level-up";
  description: string;
  celebrationMessage: string;
}

export interface Comparison {
  period1: string;
  period2: string;
  improvements: string[];
  stats: Record<string, { before: number; after: number }>;
}

interface SkillProfile {
  name: string;
  currentLevel: SkillLevel;
  entries: GrowthEntry[];
  firstSeen: number;
  lastSeen: number;
}

interface TrackerStore {
  skills: SkillProfile[];
  firsts: { type: string; timestamp: number; sessionId: string }[];
  counters: Record<string, number>;
}

// ── Persistence ─────────────────────────────────────────────

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

function loadStore(): TrackerStore {
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

function saveStore(store: TrackerStore): void {
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

const LEVEL_ORDER: Record<SkillLevel, number> = {
  beginner: 0,
  intermediate: 1,
  advanced: 2,
  expert: 3,
};

const LEVEL_LABELS: SkillLevel[] = ["beginner", "intermediate", "advanced", "expert"];

function levelName(level: SkillLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

// ── GrowthTracker ───────────────────────────────────────────

export class GrowthTracker {
  private static instance: GrowthTracker | null = null;

  private constructor() {}

  static getInstance(): GrowthTracker {
    if (!GrowthTracker.instance) {
      GrowthTracker.instance = new GrowthTracker();
    }
    return GrowthTracker.instance;
  }

  /**
   * Record a skill observation with evidence.
   */
  recordSkillObservation(skill: string, level: SkillLevel, evidence: string, sessionId?: string): void {
    const store = loadStore();
    const ts = Date.now();
    const sid = sessionId || "unknown";
    const skillKey = skill.toLowerCase();

    let profile = store.skills.find((s) => s.name.toLowerCase() === skillKey);

    if (!profile) {
      profile = {
        name: skill,
        currentLevel: level,
        entries: [],
        firstSeen: ts,
        lastSeen: ts,
      };
      store.skills.push(profile);
    }

    const entry: GrowthEntry = {
      skill: profile.name,
      level,
      evidence,
      timestamp: ts,
      sessionId: sid,
    };

    profile.entries.push(entry);
    profile.lastSeen = ts;

    // Update current level if it's higher
    if (LEVEL_ORDER[level] > LEVEL_ORDER[profile.currentLevel]) {
      profile.currentLevel = level;
    }

    saveStore(store);
  }

  /**
   * Get the full growth timeline, optionally filtered by skill.
   */
  getGrowthTimeline(skill?: string): GrowthEntry[] {
    const store = loadStore();

    let entries: GrowthEntry[] = [];
    for (const profile of store.skills) {
      if (skill && profile.name.toLowerCase() !== skill.toLowerCase()) continue;
      entries.push(...profile.entries);
    }

    entries.sort((a, b) => a.timestamp - b.timestamp);
    return entries;
  }

  /**
   * Detect milestones: firsts, counts, streaks, level-ups.
   */
  detectMilestone(currentSession: { tools: string[]; topics: string[] }, sessionId?: string): Milestone | null {
    const store = loadStore();
    const sid = sessionId || "unknown";

    // Check for "first time" milestones
    for (const tool of currentSession.tools) {
      const key = `tool:${tool}`;
      if (!store.firsts.find((f) => f.type === key)) {
        store.firsts.push({ type: key, timestamp: Date.now(), sessionId: sid });
        saveStore(store);
        return {
          type: "first",
          description: `First time using ${tool}`,
          celebrationMessage: `That's your first time using ${tool}! Nice.`,
        };
      }
    }

    for (const topic of currentSession.topics) {
      const key = `topic:${topic}`;
      if (!store.firsts.find((f) => f.type === key)) {
        store.firsts.push({ type: key, timestamp: Date.now(), sessionId: sid });
        saveStore(store);
        return {
          type: "first",
          description: `First time exploring ${topic}`,
          celebrationMessage: `First time diving into ${topic} — exciting!`,
        };
      }
    }

    // Check for count milestones
    const countKey = "total_sessions";
    store.counters[countKey] = (store.counters[countKey] || 0) + 1;
    const count = store.counters[countKey];

    const milestoneNumbers = [10, 25, 50, 100, 250, 500, 1000];
    if (milestoneNumbers.includes(count)) {
      saveStore(store);
      return {
        type: "count",
        description: `${count} sessions together`,
        celebrationMessage: `That's ${count} sessions together. We've built a lot.`,
      };
    }

    // Check for level-ups (recent skill changes)
    for (const profile of store.skills) {
      if (profile.entries.length < 2) continue;
      const recent = profile.entries[profile.entries.length - 1];
      const previous = profile.entries[profile.entries.length - 2];
      if (
        recent.sessionId === sid &&
        LEVEL_ORDER[recent.level] > LEVEL_ORDER[previous.level]
      ) {
        saveStore(store);
        return {
          type: "level-up",
          description: `${profile.name}: ${levelName(previous.level)} → ${levelName(recent.level)}`,
          celebrationMessage: `You just leveled up in ${profile.name} — from ${levelName(previous.level)} to ${levelName(recent.level)}. That growth is real.`,
        };
      }
    }

    saveStore(store);
    return null;
  }

  /**
   * Natural language summary of overall growth.
   */
  getGrowthSummary(): string {
    const store = loadStore();

    if (store.skills.length === 0) {
      return "We're just getting started — haven't tracked any skills yet.";
    }

    const parts: string[] = [];

    // Sort skills by first seen
    const sorted = store.skills.slice().sort((a, b) => a.firstSeen - b.firstSeen);
    const earliest = sorted[0];
    const startDate = new Date(earliest.firstSeen).toLocaleDateString("en-US", { month: "long", year: "numeric" });

    parts.push(`Tracking growth since ${startDate}.`);

    // Expert-level skills
    const expertSkills = store.skills.filter((s) => s.currentLevel === "expert");
    if (expertSkills.length > 0) {
      parts.push(`Expert level in: ${expertSkills.map((s) => s.name).join(", ")}.`);
    }

    // Advanced skills
    const advancedSkills = store.skills.filter((s) => s.currentLevel === "advanced");
    if (advancedSkills.length > 0) {
      parts.push(`Advanced in: ${advancedSkills.map((s) => s.name).join(", ")}.`);
    }

    // Count milestones
    const totalFirsts = store.firsts.length;
    if (totalFirsts > 0) {
      parts.push(`${totalFirsts} "first time" milestones hit.`);
    }

    // Most improved (most entries = most practice)
    const mostPracticed = store.skills
      .slice()
      .sort((a, b) => b.entries.length - a.entries.length)
      .slice(0, 3);

    if (mostPracticed.length > 0) {
      parts.push(`Most practiced: ${mostPracticed.map((s) => `${s.name} (${s.entries.length} observations)`).join(", ")}.`);
    }

    // Recent level-ups
    const recentLevelUps: string[] = [];
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const skill of store.skills) {
      const recentEntries = skill.entries.filter((e) => e.timestamp >= thirtyDaysAgo);
      if (recentEntries.length >= 2) {
        const first = recentEntries[0];
        const last = recentEntries[recentEntries.length - 1];
        if (LEVEL_ORDER[last.level] > LEVEL_ORDER[first.level]) {
          recentLevelUps.push(`${skill.name}: ${levelName(first.level)} -> ${levelName(last.level)}`);
        }
      }
    }

    if (recentLevelUps.length > 0) {
      parts.push(`Recent growth: ${recentLevelUps.join("; ")}.`);
    }

    return parts.join(" ");
  }

  /**
   * Compare two time periods: "2026-02" vs "2026-03".
   */
  comparePeriods(period1: string, period2: string): Comparison {
    const store = loadStore();

    const p1Start = new Date(period1 + "-01").getTime();
    const p1End = this.endOfMonth(period1);
    const p2Start = new Date(period2 + "-01").getTime();
    const p2End = this.endOfMonth(period2);

    const improvements: string[] = [];
    const stats: Record<string, { before: number; after: number }> = {};

    for (const skill of store.skills) {
      const p1Entries = skill.entries.filter((e) => e.timestamp >= p1Start && e.timestamp <= p1End);
      const p2Entries = skill.entries.filter((e) => e.timestamp >= p2Start && e.timestamp <= p2End);

      if (p1Entries.length > 0 || p2Entries.length > 0) {
        stats[`${skill.name}_observations`] = {
          before: p1Entries.length,
          after: p2Entries.length,
        };
      }

      // Check for level improvement
      if (p1Entries.length > 0 && p2Entries.length > 0) {
        const p1Best = Math.max(...p1Entries.map((e) => LEVEL_ORDER[e.level]));
        const p2Best = Math.max(...p2Entries.map((e) => LEVEL_ORDER[e.level]));
        if (p2Best > p1Best) {
          improvements.push(
            `${skill.name}: ${levelName(LEVEL_LABELS[p1Best])} -> ${levelName(LEVEL_LABELS[p2Best])}`
          );
        }
      }

      // New skill in period 2
      if (p1Entries.length === 0 && p2Entries.length > 0) {
        improvements.push(`Started learning ${skill.name}`);
      }
    }

    // Count firsts per period
    const p1Firsts = store.firsts.filter((f) => f.timestamp >= p1Start && f.timestamp <= p1End).length;
    const p2Firsts = store.firsts.filter((f) => f.timestamp >= p2Start && f.timestamp <= p2End).length;
    stats["first_time_milestones"] = { before: p1Firsts, after: p2Firsts };

    if (p2Firsts > p1Firsts) {
      improvements.push(`${p2Firsts - p1Firsts} more "first time" milestones`);
    }

    return { period1, period2, improvements, stats };
  }

  /** Orchestrator signal: a growth summary, when there's enough of one to be worth surfacing. */
  signalsFor(): ModuleSignal[] {
    const summary = this.getGrowthSummary();
    if (!summary || summary.length <= 10) return [];
    return [{ source: "growth-tracker", signal: summary, priority: 3, category: "growth", confidence: 1.0 }];
  }

  // ── Private helpers ─────────────────────────────────────────

  private endOfMonth(yearMonth: string): number {
    const [year, month] = yearMonth.split("-").map(Number);
    return new Date(year, month, 0, 23, 59, 59, 999).getTime();
  }
}
