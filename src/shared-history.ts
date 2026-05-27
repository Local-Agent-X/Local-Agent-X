/**
 * Shared History — Living timeline of the relationship.
 *
 * Records significant shared moments (apps built, bugs fixed, breakthroughs,
 * fun conversations) and generates natural-language recaps and relationship
 * summaries.
 *
 * Persists to ~/.lax/shared-history.json (max 2000 moments).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getLaxDir } from "./lax-data-dir.js";

// ── Types ────────────────────────────────────────────────────

export type MomentCategory = "build" | "debug" | "research" | "creative" | "personal" | "milestone";

export interface HistoryMoment {
  id: string;
  description: string;
  category: MomentCategory;
  timestamp: number;
  sessionId: string;
  significance: number; // 1-10
  emotions?: string[];
  entities?: string[];
}

export interface RelationshipSummary {
  startDate: string;
  daysTogether: number;
  totalConversations: number;
  totalApps: number;
  stats: Record<string, number>;
  highlights: string[];
}

interface HistoryStore {
  moments: HistoryMoment[];
  firstInteraction: number | null;
  conversationCount: number;
}

// ── Constants ───────────────────────────────────────────────

const LAX_DIR = getLaxDir();
const STORE_FILE = join(LAX_DIR, "shared-history.json");
const MAX_MOMENTS = 2000;

// ── Category keywords for auto-detection ────────────────────

const CATEGORY_KEYWORDS: Record<MomentCategory, RegExp[]> = {
  build: [/built/i, /created/i, /shipped/i, /deployed/i, /launched/i, /new app/i, /implemented/i],
  debug: [/fixed/i, /bug/i, /debug/i, /error/i, /resolved/i, /crash/i, /patch/i],
  research: [/research/i, /learned/i, /discovered/i, /figured out/i, /investigated/i, /explored/i],
  creative: [/design/i, /creative/i, /idea/i, /brainstorm/i, /concept/i, /prototype/i],
  personal: [/personal/i, /chat/i, /fun/i, /joke/i, /story/i, /hangout/i],
  milestone: [/milestone/i, /first/i, /100th/i, /anniversary/i, /achievement/i, /record/i],
};

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

function loadStore(): HistoryStore {
  if (!existsSync(STORE_FILE)) return { moments: [], firstInteraction: null, conversationCount: 0 };
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      moments: Array.isArray(parsed.moments) ? parsed.moments : [],
      firstInteraction: parsed.firstInteraction ?? null,
      conversationCount: parsed.conversationCount ?? 0,
    };
  } catch {
    return { moments: [], firstInteraction: null, conversationCount: 0 };
  }
}

function saveStore(store: HistoryStore): void {
  ensureDir();
  if (store.moments.length > MAX_MOMENTS) {
    store.moments = store.moments.slice(-MAX_MOMENTS);
  }
  atomicWrite(STORE_FILE, JSON.stringify(store, null, 2));
}

// ── Helpers ─────────────────────────────────────────────────

function autoDetectCategory(description: string): MomentCategory {
  for (const [cat, patterns] of Object.entries(CATEGORY_KEYWORDS) as [MomentCategory, RegExp[]][]) {
    for (const p of patterns) {
      if (p.test(description)) return cat;
    }
  }
  return "personal";
}

function daysBetween(a: number, b: number): number {
  return Math.floor(Math.abs(b - a) / (1000 * 60 * 60 * 24));
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().split("T")[0];
}

// ── SharedHistory class ─────────────────────────────────────

export class SharedHistory {
  private static instance: SharedHistory | null = null;
  private store: HistoryStore;

  private constructor() {
    this.store = loadStore();
  }

  static getInstance(): SharedHistory {
    if (!SharedHistory.instance) SharedHistory.instance = new SharedHistory();
    return SharedHistory.instance;
  }

  /** Record a significant shared moment. */
  recordMoment(moment: Omit<HistoryMoment, "id" | "category"> & { category?: MomentCategory }): void {
    const entry: HistoryMoment = {
      ...moment,
      id: randomBytes(8).toString("hex"),
      category: moment.category ?? autoDetectCategory(moment.description),
      significance: Math.max(1, Math.min(10, moment.significance)),
    };

    if (!this.store.firstInteraction) {
      this.store.firstInteraction = entry.timestamp;
    }

    this.store.moments.push(entry);
    saveStore(this.store);
  }

  /** Increment conversation count. */
  recordConversation(): void {
    this.store.conversationCount++;
    if (!this.store.firstInteraction) {
      this.store.firstInteraction = Date.now();
    }
    saveStore(this.store);
  }

  /** Get the timeline with optional filters. */
  getTimeline(filter?: { category?: MomentCategory; dateRange?: { from: number; to: number }; limit?: number }): HistoryMoment[] {
    let results = [...this.store.moments];

    if (filter?.category) {
      results = results.filter(m => m.category === filter.category);
    }
    if (filter?.dateRange) {
      results = results.filter(m => m.timestamp >= filter.dateRange!.from && m.timestamp <= filter.dateRange!.to);
    }

    results.sort((a, b) => b.timestamp - a.timestamp);

    if (filter?.limit && filter.limit > 0) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  /** High-level relationship summary. */
  getRelationshipSummary(): RelationshipSummary {
    const now = Date.now();
    const start = this.store.firstInteraction ?? now;
    const days = daysBetween(start, now);

    const byCategory: Record<string, number> = {};
    for (const m of this.store.moments) {
      byCategory[m.category] = (byCategory[m.category] ?? 0) + 1;
    }

    const appCount = byCategory["build"] ?? 0;
    const bugCount = byCategory["debug"] ?? 0;

    // find most productive day of week
    const dayCounts = [0, 0, 0, 0, 0, 0, 0];
    for (const m of this.store.moments) {
      dayCounts[new Date(m.timestamp).getDay()]++;
    }
    const bestDayIdx = dayCounts.indexOf(Math.max(...dayCounts));

    // favorite work hours
    const hourCounts: Record<number, number> = {};
    for (const m of this.store.moments) {
      const h = new Date(m.timestamp).getHours();
      hourCounts[h] = (hourCounts[h] ?? 0) + 1;
    }
    const peakHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";

    const highlights = this.store.moments
      .filter(m => m.significance >= 8)
      .sort((a, b) => b.significance - a.significance)
      .slice(0, 5)
      .map(m => m.description);

    return {
      startDate: formatDate(start),
      daysTogether: days,
      totalConversations: this.store.conversationCount,
      totalApps: appCount,
      stats: {
        ...byCategory,
        totalMoments: this.store.moments.length,
        totalBugs: bugCount,
        mostProductiveDayIndex: bestDayIdx,
        peakHour: Number(peakHour),
      },
      highlights,
    };
  }

  /** Anniversary and days-together info. */
  getAnniversary(): { date: string; daysTogether: number; milestone?: string } | null {
    if (!this.store.firstInteraction) return null;

    const days = daysBetween(this.store.firstInteraction, Date.now());
    let milestone: string | undefined;

    if (days === 100) milestone = "100 days together";
    else if (days === 365) milestone = "1 year together";
    else if (days === 30) milestone = "1 month together";
    else if (days === 7) milestone = "1 week together";
    else if (days === 200) milestone = "200 days together";
    else if (days === 500) milestone = "500 days together";

    return {
      date: formatDate(this.store.firstInteraction),
      daysTogether: days,
      milestone,
    };
  }

  /** Most memorable moments by significance and emotional intensity. */
  getMostMemorableMoments(limit: number = 10): HistoryMoment[] {
    return [...this.store.moments]
      .sort((a, b) => {
        const aScore = a.significance + (a.emotions?.length ?? 0);
        const bScore = b.significance + (b.emotions?.length ?? 0);
        return bScore - aScore;
      })
      .slice(0, limit);
  }

  /** Generate a natural-language recap for a given period. */
  generateRecap(period: "week" | "month" | "year"): string {
    const now = Date.now();
    const msMap = { week: 7 * 86400000, month: 30 * 86400000, year: 365 * 86400000 };
    const cutoff = now - msMap[period];
    const recent = this.store.moments.filter(m => m.timestamp >= cutoff);

    if (recent.length === 0) {
      return `Nothing recorded this ${period} yet. Let's make some memories.`;
    }

    const byCategory: Record<string, HistoryMoment[]> = {};
    for (const m of recent) {
      if (!byCategory[m.category]) byCategory[m.category] = [];
      byCategory[m.category].push(m);
    }

    const parts: string[] = [];
    const periodLabel = period === "week" ? "This week" : period === "month" ? "This month" : "This year";

    if (byCategory["build"]?.length) {
      const names = byCategory["build"].slice(0, 3).map(m => m.description);
      parts.push(`built ${names.join(", ")}`);
    }
    if (byCategory["debug"]?.length) {
      parts.push(`fixed ${byCategory["debug"].length} bug${byCategory["debug"].length > 1 ? "s" : ""}`);
    }
    if (byCategory["research"]?.length) {
      parts.push(`researched ${byCategory["research"].length} thing${byCategory["research"].length > 1 ? "s" : ""}`);
    }
    if (byCategory["creative"]?.length) {
      parts.push(`had ${byCategory["creative"].length} creative session${byCategory["creative"].length > 1 ? "s" : ""}`);
    }

    const best = recent.sort((a, b) => b.significance - a.significance)[0];
    const bestPart = best ? ` Best moment: ${best.description}.` : "";

    if (parts.length === 0) {
      return `${periodLabel}: ${recent.length} moment${recent.length > 1 ? "s" : ""} recorded.${bestPart}`;
    }

    return `${periodLabel}: we ${parts.join(", ")}.${bestPart}`;
  }

  /** Reload store from disk. */
  reload(): void {
    this.store = loadStore();
  }

  /** Reset singleton (testing). */
  static reset(): void {
    SharedHistory.instance = null;
  }
}
