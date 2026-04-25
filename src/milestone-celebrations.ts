/**
 * Milestone Celebrations — Track and celebrate achievements.
 *
 * Monitors conversation counts, app builds, streaks, first-time tool
 * usage, time milestones, and personal events to trigger natural
 * celebration messages scaled to the current trust level.
 *
 * Persists to ~/.sax/milestones.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────

export type MilestoneType = "count" | "streak" | "first-time" | "time" | "achievement" | "personal";

export interface Milestone {
  id: string;
  type: MilestoneType;
  title: string;
  description: string;
  celebrationMessage: string;
  unlockedAt?: number;
  progress?: number;
  target?: number;
}

export interface MilestoneContext {
  conversationCount: number;
  appCount: number;
  daysTogether: number;
  toolsUsed: string[];
  streak: number;
}

interface MilestoneStore {
  unlocked: Milestone[];
  knownTools: string[];
  birthday: string | null;
  startDate: number | null;
}

// ── Constants ───────────────────────────────────────────────

const LAX_DIR = join(homedir(), ".lax");
const STORE_FILE = join(LAX_DIR, "milestones.json");

// ── Built-in milestone definitions ──────────────────────────

interface MilestoneDef {
  id: string;
  type: MilestoneType;
  title: string;
  description: string;
  check: (ctx: MilestoneContext, store: MilestoneStore) => { triggered: boolean; progress?: number; target?: number };
  celebrate: (ctx: MilestoneContext) => string;
}

const CONVERSATION_THRESHOLDS = [10, 25, 50, 100, 250, 500, 1000];
const APP_THRESHOLDS = [1, 5, 10, 25, 50];
const STREAK_THRESHOLDS = [7, 14, 30, 60, 100];
const TIME_MILESTONES: { days: number; label: string }[] = [
  { days: 7, label: "1 week" },
  { days: 30, label: "1 month" },
  { days: 90, label: "3 months" },
  { days: 180, label: "6 months" },
  { days: 365, label: "1 year" },
];

const FIRST_TIME_TOOLS = [
  "swarm", "mission", "cron", "browser", "voice", "camera",
  "telegram", "whatsapp", "youtube", "code-exec",
];

function buildMilestoneDefs(): MilestoneDef[] {
  const defs: MilestoneDef[] = [];

  // Conversation count milestones
  for (const threshold of CONVERSATION_THRESHOLDS) {
    defs.push({
      id: `convo-${threshold}`,
      type: "count",
      title: `${threshold} Conversations`,
      description: `Reached ${threshold} conversations together`,
      check: (ctx) => ({
        triggered: ctx.conversationCount >= threshold,
        progress: Math.min(ctx.conversationCount, threshold),
        target: threshold,
      }),
      celebrate: (_ctx) => {
        if (threshold === 10) return `That's 10 conversations! We're just getting warmed up.`;
        if (threshold === 25) return `25 conversations deep. Getting into a groove.`;
        if (threshold === 50) return `50 conversations. We've built up some serious history now.`;
        if (threshold === 100) return `100 conversations. We've come a long way from the beginning.`;
        if (threshold === 250) return `250 conversations — that's a real partnership at this point.`;
        if (threshold === 500) return `500 conversations. Half a thousand. That's legendary.`;
        return `${threshold} conversations. Absolutely unreal.`;
      },
    });
  }

  // App build milestones
  for (const threshold of APP_THRESHOLDS) {
    defs.push({
      id: `apps-${threshold}`,
      type: "count",
      title: `${threshold} App${threshold > 1 ? "s" : ""} Built`,
      description: `Built ${threshold} app${threshold > 1 ? "s" : ""} together`,
      check: (ctx) => ({
        triggered: ctx.appCount >= threshold,
        progress: Math.min(ctx.appCount, threshold),
        target: threshold,
      }),
      celebrate: (_ctx) => {
        if (threshold === 1) return `First app built together! The first of many.`;
        if (threshold === 5) return `5 apps shipped. We're a production line at this point.`;
        if (threshold === 10) return `Double digits — 10 apps built. Prolific.`;
        if (threshold === 25) return `25 apps. You're building an empire.`;
        return `${threshold} apps. That's a whole portfolio.`;
      },
    });
  }

  // Streak milestones
  for (const threshold of STREAK_THRESHOLDS) {
    defs.push({
      id: `streak-${threshold}`,
      type: "streak",
      title: `${threshold}-Day Streak`,
      description: `${threshold} consecutive days of conversation`,
      check: (ctx) => ({
        triggered: ctx.streak >= threshold,
        progress: Math.min(ctx.streak, threshold),
        target: threshold,
      }),
      celebrate: (_ctx) => {
        if (threshold === 7) return `7 days straight! That's a full week of consistency.`;
        if (threshold === 14) return `Two weeks running — the streak is real.`;
        if (threshold === 30) return `30-day streak. A whole month of daily collabs.`;
        if (threshold === 60) return `60-day streak. That dedication is something else.`;
        return `${threshold}-day streak. That's commitment.`;
      },
    });
  }

  // Time milestones
  for (const { days, label } of TIME_MILESTONES) {
    defs.push({
      id: `time-${days}`,
      type: "time",
      title: `${label} Together`,
      description: `It's been ${label} since we started`,
      check: (ctx) => ({
        triggered: ctx.daysTogether >= days,
        progress: Math.min(ctx.daysTogether, days),
        target: days,
      }),
      celebrate: (_ctx) => {
        if (days === 7) return `One week together! Still early but we're getting somewhere.`;
        if (days === 30) return `One month! Time flies when you're shipping code.`;
        if (days === 90) return `3 months. A whole quarter of building things together.`;
        if (days === 180) return `Half a year. We've been through a lot together at this point.`;
        return `A full year together. That's a real milestone.`;
      },
    });
  }

  // First-time tool usage
  for (const tool of FIRST_TIME_TOOLS) {
    defs.push({
      id: `first-${tool}`,
      type: "first-time",
      title: `First ${tool.charAt(0).toUpperCase() + tool.slice(1)}`,
      description: `Used ${tool} for the first time`,
      check: (ctx, _store) => ({
        triggered: ctx.toolsUsed.includes(tool),
      }),
      celebrate: (_ctx) => `First time using ${tool}! New tools unlocked.`,
    });
  }

  return defs;
}

// ── Persistence ─────────────────────────────────────────────

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

function loadStore(): MilestoneStore {
  if (!existsSync(STORE_FILE)) {
    return { unlocked: [], knownTools: [], birthday: null, startDate: null };
  }
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      unlocked: Array.isArray(parsed.unlocked) ? parsed.unlocked : [],
      knownTools: Array.isArray(parsed.knownTools) ? parsed.knownTools : [],
      birthday: parsed.birthday ?? null,
      startDate: parsed.startDate ?? null,
    };
  } catch {
    return { unlocked: [], knownTools: [], birthday: null, startDate: null };
  }
}

function saveStore(store: MilestoneStore): void {
  ensureDir();
  atomicWrite(STORE_FILE, JSON.stringify(store, null, 2));
}

// ── MilestoneCelebrator class ───────────────────────────────

export class MilestoneCelebrator {
  private static instance: MilestoneCelebrator | null = null;
  private store: MilestoneStore;
  private defs: MilestoneDef[];

  private constructor() {
    this.store = loadStore();
    this.defs = buildMilestoneDefs();
  }

  static getInstance(): MilestoneCelebrator {
    if (!MilestoneCelebrator.instance) MilestoneCelebrator.instance = new MilestoneCelebrator();
    return MilestoneCelebrator.instance;
  }

  /** Check all milestone definitions and return any newly triggered ones. */
  checkMilestones(context: MilestoneContext): Milestone[] {
    const unlockedIds = new Set(this.store.unlocked.map(m => m.id));
    const newlyUnlocked: Milestone[] = [];

    if (!this.store.startDate) {
      this.store.startDate = Date.now();
    }

    for (const def of this.defs) {
      if (unlockedIds.has(def.id)) continue;

      const result = def.check(context, this.store);
      if (result.triggered) {
        const milestone: Milestone = {
          id: def.id,
          type: def.type,
          title: def.title,
          description: def.description,
          celebrationMessage: def.celebrate(context),
          unlockedAt: Date.now(),
          progress: result.progress,
          target: result.target,
        };
        this.store.unlocked.push(milestone);
        newlyUnlocked.push(milestone);
      }
    }

    // Track tools
    for (const tool of context.toolsUsed) {
      if (!this.store.knownTools.includes(tool)) {
        this.store.knownTools.push(tool);
      }
    }

    if (newlyUnlocked.length > 0) {
      saveStore(this.store);
    }

    return newlyUnlocked;
  }

  /** Generate a celebration message for a milestone. */
  celebrate(milestone: Milestone): string {
    return milestone.celebrationMessage;
  }

  /** Get all previously unlocked milestones. */
  getUnlockedMilestones(): Milestone[] {
    return [...this.store.unlocked].sort((a, b) => (b.unlockedAt ?? 0) - (a.unlockedAt ?? 0));
  }

  /** Get upcoming milestones with progress toward them. */
  getNextMilestones(context?: MilestoneContext): Milestone[] {
    const unlockedIds = new Set(this.store.unlocked.map(m => m.id));
    const upcoming: Milestone[] = [];

    if (!context) return upcoming;

    for (const def of this.defs) {
      if (unlockedIds.has(def.id)) continue;

      const result = def.check(context, this.store);
      if (!result.triggered && result.progress !== undefined && result.target !== undefined) {
        upcoming.push({
          id: def.id,
          type: def.type,
          title: def.title,
          description: def.description,
          celebrationMessage: "",
          progress: result.progress,
          target: result.target,
        });
      }
    }

    // Sort by closest to completion
    return upcoming.sort((a, b) => {
      const aPct = (a.progress ?? 0) / (a.target ?? 1);
      const bPct = (b.progress ?? 0) / (b.target ?? 1);
      return bPct - aPct;
    });
  }

  /** Set the user's birthday for personal milestones. */
  setBirthday(date: string): void {
    this.store.birthday = date;
    saveStore(this.store);
  }

  /** Reload store from disk. */
  reload(): void {
    this.store = loadStore();
  }

  /** Reset singleton (testing). */
  static reset(): void {
    MilestoneCelebrator.instance = null;
  }
}
