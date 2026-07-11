/**
 * Predictive Prefetch — pre-loads relevant memories based on
 * time-of-day and day-of-week usage patterns.
 *
 * Builds a probability model of what the user works on at what times,
 * then warms a cache of likely-needed memories before the user asks.
 *
 * Persists schedule data to ~/.lax/schedule-profile.json (max 2000 entries).
 * Persistence is debounced: learnSchedule runs on every message (turn path),
 * so it only mutates in-memory state and coalesces disk writes into one
 * deferred save instead of rewriting the full store synchronously per call.
 */

import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { atomicWriteFileSync, createJsonStore, ensureDirFor } from "../util/json-store.js";

// ── Types ────────────────────────────────────────────────────

export interface PredictedTopic {
  topic: string;
  confidence: number;
  basedOn: string;
  lastSeen: number;
}

export interface PrefetchResult {
  predictions: PredictedTopic[];
  preloadedMemories: { topic: string; memories: string[] }[];
  confidence: number;
}

export interface ScheduleProfile {
  weeklyHeatmap: Record<string, Record<number, string[]>>;
  peakHours: { work: number[]; personal: number[]; creative: number[] };
  totalDataPoints: number;
}

interface ScheduleEntry {
  timestamp: number;
  timeOfDay: number;
  dayOfWeek: number;
  topics: string[];
  entities: string[];
}

interface ScheduleStore extends Record<string, unknown> {
  entries: ScheduleEntry[];
  cache: Record<string, string[]>;
}

// ── Constants ───────────────────────────────────────────────

const LAX_DIR = getLaxDir();
const PROFILE_FILE = join(LAX_DIR, "schedule-profile.json");
const MAX_ENTRIES = 2000;
const SAVE_DEBOUNCE_MS = 5_000;

const DAY_NAMES: string[] = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];

const WORK_KEYWORDS = [
  "deploy", "pr", "review", "meeting", "jira", "ticket", "sprint",
  "standup", "release", "bug", "fix", "refactor", "api", "database",
  "server", "pipeline", "test", "ci", "build", "merge", "code",
];

const PERSONAL_KEYWORDS = [
  "music", "movie", "game", "recipe", "workout", "travel", "shopping",
  "family", "friend", "hobby", "book", "read", "watch", "play",
  "restaurant", "vacation", "birthday", "health",
];

const CREATIVE_KEYWORDS = [
  "design", "sketch", "write", "story", "art", "brainstorm", "idea",
  "prototype", "experiment", "explore", "creative", "compose", "invent",
  "imagine", "concept", "draft",
];

// ── Persistence ─────────────────────────────────────────────

const jsonStore = createJsonStore<ScheduleStore>(PROFILE_FILE, {
  defaults: () => ({ entries: [], cache: {} }),
});

function saveStore(store: ScheduleStore): void {
  ensureDirFor(PROFILE_FILE);
  if (store.entries.length > MAX_ENTRIES) {
    store.entries = store.entries.slice(-MAX_ENTRIES);
  }
  // Written COMPACT, not through jsonStore.save (which pretty-prints): the
  // debounced flush persists up to 2000 entries and the AM-5 regression test
  // pins the compact format.
  atomicWriteFileSync(PROFILE_FILE, JSON.stringify(store));
}

// ── Helpers ─────────────────────────────────────────────────

function classifyTopic(topic: string): "work" | "personal" | "creative" | "other" {
  const lower = topic.toLowerCase();
  if (WORK_KEYWORDS.some((k) => lower.includes(k))) return "work";
  if (PERSONAL_KEYWORDS.some((k) => lower.includes(k))) return "personal";
  if (CREATIVE_KEYWORDS.some((k) => lower.includes(k))) return "creative";
  return "other";
}

function dayName(dow: number): string {
  return DAY_NAMES[dow] || "sunday";
}

// ── Class ───────────────────────────────────────────────────

export class PredictivePrefetcher {
  private static instance: PredictivePrefetcher | null = null;
  private store: ScheduleStore;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  private constructor() {
    this.store = jsonStore.load();
    // Sync writes are safe in an exit handler; without this, buffered
    // entries inside the debounce window would be lost on clean exit.
    process.once("exit", () => this.flush());
  }

  static getInstance(): PredictivePrefetcher {
    if (!PredictivePrefetcher.instance) {
      PredictivePrefetcher.instance = new PredictivePrefetcher();
    }
    return PredictivePrefetcher.instance;
  }

  /**
   * Based on historical patterns, predict what the user will need
   * at the given time and return pre-loaded memory summaries.
   */
  prefetch(timeOfDay: number, dayOfWeek: number): PrefetchResult {
    const predictions = this.getPredictedTopics(timeOfDay, dayOfWeek);
    const topicNames = predictions.map((p) => p.topic);

    const preloaded: PrefetchResult["preloadedMemories"] = [];
    for (const topic of topicNames) {
      const cached = this.store.cache[topic.toLowerCase()];
      if (cached && cached.length > 0) {
        preloaded.push({ topic, memories: cached });
      }
    }

    const confidence = predictions.length > 0
      ? predictions.reduce((sum, p) => sum + p.confidence, 0) / predictions.length
      : 0;

    return { predictions, preloadedMemories: preloaded, confidence };
  }

  /**
   * Record what the user works on at what time to build the probability model.
   * Runs on every message, so it must not touch disk: it mutates in-memory
   * state and defers persistence to the debounced save.
   */
  learnSchedule(timestamp: number, topics: string[], entities: string[]): void {
    const date = new Date(timestamp);
    const entry: ScheduleEntry = {
      timestamp,
      timeOfDay: date.getHours(),
      dayOfWeek: date.getDay(),
      topics: topics.map((t) => t.toLowerCase()),
      entities: entities.map((e) => e.toLowerCase()),
    };
    this.store.entries.push(entry);
    if (this.store.entries.length > MAX_ENTRIES) {
      this.store.entries = this.store.entries.slice(-MAX_ENTRIES);
    }
    this.scheduleSave();
  }

  /** Coalesce writes: one unref'd timer flushes all buffered mutations. */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /**
   * Persist any buffered schedule mutations now. Called by the debounce
   * timer and the process-exit hook; safe to call when nothing is pending.
   */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      saveStore(this.store);
    } catch (e) {
      this.dirty = true; // retry on the next scheduled save
      console.warn("[predictive-prefetch] failed to persist schedule profile:", e);
    }
  }

  /**
   * Weekly heat map: for each hour of each day, what topics are most likely.
   * Plus peak hours for work, personal, and creative tasks.
   */
  getScheduleProfile(): ScheduleProfile {
    const heatmap: Record<string, Record<number, string[]>> = {};
    for (const day of DAY_NAMES) {
      heatmap[day] = {};
    }

    // Build frequency map: day -> hour -> topic -> count
    const freq: Record<string, Record<number, Record<string, number>>> = {};
    for (const day of DAY_NAMES) {
      freq[day] = {};
      for (let h = 0; h < 24; h++) freq[day][h] = {};
    }

    for (const entry of this.store.entries) {
      const day = dayName(entry.dayOfWeek);
      const hour = entry.timeOfDay;
      for (const topic of entry.topics) {
        freq[day][hour][topic] = (freq[day][hour][topic] || 0) + 1;
      }
    }

    // Pick top topics per slot
    for (const day of DAY_NAMES) {
      for (let h = 0; h < 24; h++) {
        const topicCounts = freq[day][h];
        const sorted = Object.entries(topicCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([t]) => t);
        if (sorted.length > 0) {
          heatmap[day][h] = sorted;
        }
      }
    }

    // Compute peak hours per category
    const categoryHours: Record<string, Record<number, number>> = {
      work: {},
      personal: {},
      creative: {},
    };

    for (const entry of this.store.entries) {
      for (const topic of entry.topics) {
        const cat = classifyTopic(topic);
        if (cat === "other") continue;
        categoryHours[cat][entry.timeOfDay] = (categoryHours[cat][entry.timeOfDay] || 0) + 1;
      }
    }

    function topHours(counts: Record<number, number>): number[] {
      return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([h]) => parseInt(h, 10));
    }

    return {
      weeklyHeatmap: heatmap,
      peakHours: {
        work: topHours(categoryHours.work),
        personal: topHours(categoryHours.personal),
        creative: topHours(categoryHours.creative),
      },
      totalDataPoints: this.store.entries.length,
    };
  }

  /**
   * Top 5 most likely topics for the given time slot, with confidence.
   */
  getPredictedTopics(timeOfDay: number, dayOfWeek: number): PredictedTopic[] {
    const day = dayName(dayOfWeek);
    const hourWindow = 2; // look +/- 2 hours
    const dayWeight = 2; // same day-of-week entries count double

    const topicScores: Record<string, { score: number; lastSeen: number; source: string }> = {};

    for (const entry of this.store.entries) {
      const hourDiff = Math.abs(entry.timeOfDay - timeOfDay);
      const wrappedDiff = Math.min(hourDiff, 24 - hourDiff);
      if (wrappedDiff > hourWindow) continue;

      const timeFactor = 1 - wrappedDiff / (hourWindow + 1);
      const dayFactor = dayName(entry.dayOfWeek) === day ? dayWeight : 1;
      // Recency boost: more recent entries matter more
      const ageDays = (Date.now() - entry.timestamp) / (24 * 60 * 60 * 1000);
      const recencyFactor = Math.max(0.1, 1 - ageDays / 90);

      const weight = timeFactor * dayFactor * recencyFactor;

      for (const topic of entry.topics) {
        if (!topicScores[topic]) {
          topicScores[topic] = { score: 0, lastSeen: 0, source: "" };
        }
        topicScores[topic].score += weight;
        if (entry.timestamp > topicScores[topic].lastSeen) {
          topicScores[topic].lastSeen = entry.timestamp;
          topicScores[topic].source = `${day} ~${timeOfDay}:00`;
        }
      }
    }

    const sorted = Object.entries(topicScores)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 5);

    // Normalize to confidence 0-1
    const maxScore = sorted.length > 0 ? sorted[0][1].score : 1;

    return sorted.map(([topic, data]) => ({
      topic,
      confidence: Math.min(1, data.score / Math.max(maxScore, 1)),
      basedOn: data.source,
      lastSeen: data.lastSeen,
    }));
  }

  /**
   * Pre-search for given topics and cache results for instant retrieval.
   */
  warmCache(topics: string[]): void {
    for (const topic of topics) {
      const key = topic.toLowerCase();
      // Find entries mentioning this topic and extract entities as "memories"
      const related: string[] = [];
      for (const entry of this.store.entries) {
        if (entry.topics.some((t) => t.includes(key) || key.includes(t))) {
          for (const entity of entry.entities) {
            if (!related.includes(entity)) related.push(entity);
          }
        }
      }
      this.store.cache[key] = related.slice(0, 50);
    }
    this.scheduleSave();
  }
}
