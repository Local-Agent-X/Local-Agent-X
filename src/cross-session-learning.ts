/**
 * Open Agent X — Cross-Session Learning
 *
 * Detects patterns across sessions and suggests automations.
 * Tracks actions, topics, questions, and workflows to surface
 * recurring behaviors the user might want to automate.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ══════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════

export interface ActionEntry {
  sessionId: string;
  type: string;
  details: string;
  timestamp: number;
}

export interface DetectedPattern {
  type: "question" | "task" | "topic" | "time" | "workflow";
  description: string;
  occurrences: number;
  lastSeen: number;
  examples: string[];
  suggestedAction?: string;
}

export interface AutomationSuggestion {
  type: "mission" | "cron" | "shortcut";
  name: string;
  description: string;
  config: Record<string, unknown>;
}

export interface SessionInsight {
  type: string;
  description: string;
  data: unknown;
  period: "daily" | "weekly" | "monthly";
}

interface SessionData {
  actions: ActionEntry[];
  lastPrune: number;
}

// ══════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════

const LAX_DIR = join(homedir(), ".lax");
const DATA_FILE = join(LAX_DIR, "cross-session-data.json");
const MAX_ACTIONS = 5000;
const DEFAULT_MIN_OCCURRENCES = 3;
const PRUNE_AGE_DAYS = 30;
const MS_PER_DAY = 86400000;

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "about", "that",
  "this", "it", "its", "and", "or", "but", "not", "if", "then", "so",
  "what", "how", "when", "where", "who", "which", "there", "here",
  "i", "me", "my", "you", "your", "we", "our", "they", "them", "their",
]);

// ══════════════════════════════════════════════════════════
//  Singleton
// ══════════════════════════════════════════════════════════

export class CrossSessionLearner {
  private static instance: CrossSessionLearner;
  private data: SessionData;

  private constructor() {
    this.ensureDir();
    this.data = this.load();
    this.autoPrune();
  }

  static getInstance(): CrossSessionLearner {
    if (!CrossSessionLearner.instance) {
      CrossSessionLearner.instance = new CrossSessionLearner();
    }
    return CrossSessionLearner.instance;
  }

  // ── Recording ────────────────────────────────────────────

  recordAction(
    sessionId: string,
    action: { type: string; details: string; timestamp: number }
  ): void {
    this.data.actions.push({
      sessionId,
      type: action.type,
      details: action.details,
      timestamp: action.timestamp,
    });

    // FIFO: trim to max size
    if (this.data.actions.length > MAX_ACTIONS) {
      this.data.actions = this.data.actions.slice(
        this.data.actions.length - MAX_ACTIONS
      );
    }

    this.persist();
  }

  // ── Pattern Detection ────────────────────────────────────

  detectPatterns(minOccurrences?: number): DetectedPattern[] {
    const min = minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
    const patterns: DetectedPattern[] = [];

    patterns.push(...this.detectRepeatedQuestions(min));
    patterns.push(...this.detectRepeatedTasks(min));
    patterns.push(...this.detectRepeatedTopics(Math.max(min, 5)));
    patterns.push(...this.detectTimePatterns(min));
    patterns.push(...this.detectWorkflowPatterns(min));

    return patterns.sort((a, b) => b.occurrences - a.occurrences);
  }

  private detectRepeatedQuestions(min: number): DetectedPattern[] {
    const questions = this.data.actions.filter((a) => a.type === "question");
    const clusters = this.clusterBySimilarity(
      questions.map((q) => q.details),
      0.6
    );

    return clusters
      .filter((c) => c.items.length >= min)
      .map((c) => ({
        type: "question" as const,
        description: `Question asked ${c.items.length} times: "${c.representative}"`,
        occurrences: c.items.length,
        lastSeen: Math.max(
          ...questions
            .filter((q) => c.items.includes(q.details))
            .map((q) => q.timestamp)
        ),
        examples: c.items.slice(0, 5),
        suggestedAction: `Create a shortcut or FAQ entry for: "${c.representative}"`,
      }));
  }

  private detectRepeatedTasks(min: number): DetectedPattern[] {
    const tasks = this.data.actions.filter(
      (a) => a.type === "tool_call" || a.type === "task"
    );
    const taskCounts = new Map<string, { count: number; last: number; examples: string[] }>();

    for (const t of tasks) {
      const key = this.normalizeDetail(t.details);
      const existing = taskCounts.get(key);
      if (existing) {
        existing.count++;
        existing.last = Math.max(existing.last, t.timestamp);
        if (existing.examples.length < 5) existing.examples.push(t.details);
      } else {
        taskCounts.set(key, { count: 1, last: t.timestamp, examples: [t.details] });
      }
    }

    return Array.from(taskCounts.entries())
      .filter(([, v]) => v.count >= min)
      .map(([key, v]) => ({
        type: "task" as const,
        description: `Task performed ${v.count} times: "${key}"`,
        occurrences: v.count,
        lastSeen: v.last,
        examples: v.examples,
        suggestedAction: `Create a mission template for: "${key}"`,
      }));
  }

  private detectRepeatedTopics(min: number): DetectedPattern[] {
    const sessionTopics = new Map<string, Set<string>>();

    for (const a of this.data.actions) {
      if (!sessionTopics.has(a.sessionId)) {
        sessionTopics.set(a.sessionId, new Set());
      }
      const words = this.extractKeywords(a.details);
      for (const w of words) {
        sessionTopics.get(a.sessionId)!.add(w);
      }
    }

    // Count keywords across sessions
    const keywordSessions = new Map<string, Set<string>>();
    for (const [sessId, words] of sessionTopics) {
      for (const w of words) {
        if (!keywordSessions.has(w)) keywordSessions.set(w, new Set());
        keywordSessions.get(w)!.add(sessId);
      }
    }

    return Array.from(keywordSessions.entries())
      .filter(([, sessions]) => sessions.size >= min)
      .map(([keyword, sessions]) => ({
        type: "topic" as const,
        description: `Topic "${keyword}" discussed across ${sessions.size} sessions`,
        occurrences: sessions.size,
        lastSeen: Math.max(
          ...this.data.actions
            .filter((a) => a.details.toLowerCase().includes(keyword))
            .map((a) => a.timestamp),
          0
        ),
        examples: Array.from(sessions).slice(0, 5),
      }));
  }

  private detectTimePatterns(min: number): DetectedPattern[] {
    // Group actions by hour of day
    const hourBuckets = new Map<number, { count: number; types: Map<string, number> }>();

    for (const a of this.data.actions) {
      const hour = new Date(a.timestamp).getHours();
      if (!hourBuckets.has(hour)) {
        hourBuckets.set(hour, { count: 0, types: new Map() });
      }
      const bucket = hourBuckets.get(hour)!;
      bucket.count++;
      bucket.types.set(a.type, (bucket.types.get(a.type) || 0) + 1);
    }

    const patterns: DetectedPattern[] = [];

    for (const [hour, bucket] of hourBuckets) {
      for (const [actionType, count] of bucket.types) {
        if (count >= min) {
          const timeStr = `${hour.toString().padStart(2, "0")}:00`;
          patterns.push({
            type: "time",
            description: `"${actionType}" often happens around ${timeStr} (${count} times)`,
            occurrences: count,
            lastSeen: Math.max(
              ...this.data.actions
                .filter(
                  (a) =>
                    a.type === actionType &&
                    new Date(a.timestamp).getHours() === hour
                )
                .map((a) => a.timestamp),
              0
            ),
            examples: [`${actionType} at ${timeStr}`],
            suggestedAction: `Set up a cron job for "${actionType}" at ${timeStr}`,
          });
        }
      }
    }

    return patterns;
  }

  private detectWorkflowPatterns(min: number): DetectedPattern[] {
    // Find sequences of 2-4 actions that repeat within sessions
    const sessionActions = new Map<string, ActionEntry[]>();
    for (const a of this.data.actions) {
      if (!sessionActions.has(a.sessionId)) {
        sessionActions.set(a.sessionId, []);
      }
      sessionActions.get(a.sessionId)!.push(a);
    }

    // Sort within sessions by timestamp
    for (const actions of sessionActions.values()) {
      actions.sort((a, b) => a.timestamp - b.timestamp);
    }

    const sequenceCounts = new Map<string, { count: number; last: number; steps: string[] }>();

    for (const actions of sessionActions.values()) {
      for (let windowSize = 2; windowSize <= 4; windowSize++) {
        for (let i = 0; i <= actions.length - windowSize; i++) {
          const seq = actions.slice(i, i + windowSize);
          const key = seq.map((a) => a.type).join(" -> ");
          const existing = sequenceCounts.get(key);
          if (existing) {
            existing.count++;
            existing.last = Math.max(existing.last, seq[seq.length - 1].timestamp);
          } else {
            sequenceCounts.set(key, {
              count: 1,
              last: seq[seq.length - 1].timestamp,
              steps: seq.map((a) => a.type),
            });
          }
        }
      }
    }

    return Array.from(sequenceCounts.entries())
      .filter(([, v]) => v.count >= min)
      .map(([key, v]) => ({
        type: "workflow" as const,
        description: `Workflow "${key}" repeated ${v.count} times`,
        occurrences: v.count,
        lastSeen: v.last,
        examples: [key],
        suggestedAction: `Bundle "${key}" into a single mission or shortcut`,
      }));
  }

  // ── Suggestions ──────────────────────────────────────────

  suggestAutomation(pattern: DetectedPattern): AutomationSuggestion {
    switch (pattern.type) {
      case "question":
        return {
          type: "shortcut",
          name: `auto-answer-${this.slugify(pattern.description.slice(0, 40))}`,
          description: `You've asked this ${pattern.occurrences} times — want me to remember the answer?`,
          config: {
            trigger: pattern.examples[0] || pattern.description,
            patternType: "question",
            occurrences: pattern.occurrences,
          },
        };

      case "task":
        return {
          type: "mission",
          name: `auto-task-${this.slugify(pattern.description.slice(0, 40))}`,
          description: `You've done this ${pattern.occurrences} times — want me to make this a mission?`,
          config: {
            steps: pattern.examples,
            patternType: "task",
            occurrences: pattern.occurrences,
          },
        };

      case "time":
        return {
          type: "cron",
          name: `scheduled-${this.slugify(pattern.description.slice(0, 40))}`,
          description: `This happens regularly at the same time — want me to set up a cron job?`,
          config: {
            schedule: pattern.suggestedAction || "",
            patternType: "time",
            occurrences: pattern.occurrences,
          },
        };

      case "topic":
        return {
          type: "shortcut",
          name: `topic-${this.slugify(pattern.description.slice(0, 40))}`,
          description: `This topic comes up often — want me to add it to your briefing?`,
          config: {
            topic: pattern.description,
            patternType: "topic",
            occurrences: pattern.occurrences,
          },
        };

      case "workflow":
        return {
          type: "mission",
          name: `workflow-${this.slugify(pattern.description.slice(0, 40))}`,
          description: `This sequence repeats often — want me to bundle it into a mission?`,
          config: {
            sequence: pattern.examples,
            patternType: "workflow",
            occurrences: pattern.occurrences,
          },
        };

      default:
        return {
          type: "shortcut",
          name: `pattern-${Date.now()}`,
          description: `Detected pattern: ${pattern.description}`,
          config: { raw: pattern },
        };
    }
  }

  // ── Insights ─────────────────────────────────────────────

  getInsights(): SessionInsight[] {
    const insights: SessionInsight[] = [];
    const now = Date.now();

    // Most common tasks (weekly)
    const weekActions = this.data.actions.filter(
      (a) => now - a.timestamp < 7 * MS_PER_DAY
    );
    const taskFreq = new Map<string, number>();
    for (const a of weekActions) {
      taskFreq.set(a.type, (taskFreq.get(a.type) || 0) + 1);
    }
    const topTasks = Array.from(taskFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (topTasks.length > 0) {
      insights.push({
        type: "common_tasks",
        description: `Top tasks this week: ${topTasks.map(([t, c]) => `${t} (${c}x)`).join(", ")}`,
        data: Object.fromEntries(topTasks),
        period: "weekly",
      });
    }

    // Peak productivity hours (weekly)
    const hourCounts = new Array(24).fill(0);
    for (const a of weekActions) {
      hourCounts[new Date(a.timestamp).getHours()]++;
    }
    const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
    if (weekActions.length > 0) {
      insights.push({
        type: "peak_hours",
        description: `Most active hour this week: ${peakHour.toString().padStart(2, "0")}:00 (${hourCounts[peakHour]} actions)`,
        data: { peakHour, distribution: hourCounts },
        period: "weekly",
      });
    }

    // Sessions per day (daily)
    const todayActions = this.data.actions.filter(
      (a) => now - a.timestamp < MS_PER_DAY
    );
    const todaySessions = new Set(todayActions.map((a) => a.sessionId)).size;
    insights.push({
      type: "daily_sessions",
      description: `${todaySessions} session(s) today with ${todayActions.length} total actions`,
      data: { sessions: todaySessions, actions: todayActions.length },
      period: "daily",
    });

    // Monthly trends
    const monthActions = this.data.actions.filter(
      (a) => now - a.timestamp < 30 * MS_PER_DAY
    );
    const weeklyBuckets: number[] = [0, 0, 0, 0];
    for (const a of monthActions) {
      const weeksAgo = Math.floor((now - a.timestamp) / (7 * MS_PER_DAY));
      if (weeksAgo < 4) weeklyBuckets[weeksAgo]++;
    }
    insights.push({
      type: "monthly_trend",
      description: `Activity trend (recent to oldest week): ${weeklyBuckets.join(", ")} actions`,
      data: { weeklyBuckets },
      period: "monthly",
    });

    return insights;
  }

  // ── Fuzzy Matching ───────────────────────────────────────

  fuzzyMatch(a: string, b: string): number {
    const setA = this.wordSet(a);
    const setB = this.wordSet(b);
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const word of setA) {
      if (setB.has(word)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  // ══════════════════════════════════════════════════════════
  //  Internal helpers
  // ══════════════════════════════════════════════════════════

  private wordSet(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    );
  }

  private extractKeywords(text: string): string[] {
    return Array.from(this.wordSet(text));
  }

  private normalizeDetail(detail: string): string {
    return detail
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 50);
  }

  private clusterBySimilarity(
    items: string[],
    threshold: number
  ): { representative: string; items: string[] }[] {
    const clusters: { representative: string; items: string[] }[] = [];
    const assigned = new Set<number>();

    for (let i = 0; i < items.length; i++) {
      if (assigned.has(i)) continue;

      const cluster = [items[i]];
      assigned.add(i);

      for (let j = i + 1; j < items.length; j++) {
        if (assigned.has(j)) continue;
        if (this.fuzzyMatch(items[i], items[j]) >= threshold) {
          cluster.push(items[j]);
          assigned.add(j);
        }
      }

      clusters.push({ representative: items[i], items: cluster });
    }

    return clusters;
  }

  private autoPrune(): void {
    const now = Date.now();
    const lastPrune = this.data.lastPrune || 0;

    if (now - lastPrune < MS_PER_DAY) return;

    const cutoff = now - PRUNE_AGE_DAYS * MS_PER_DAY;

    // Build a set of action types that appear fewer than 3 times
    const typeCounts = new Map<string, number>();
    for (const a of this.data.actions) {
      typeCounts.set(a.type, (typeCounts.get(a.type) || 0) + 1);
    }

    const before = this.data.actions.length;
    this.data.actions = this.data.actions.filter((a) => {
      // Keep recent actions
      if (a.timestamp > cutoff) return true;
      // Keep actions whose type appears 3+ times total
      if ((typeCounts.get(a.type) || 0) >= 3) return true;
      // Prune old, infrequent actions
      return false;
    });

    this.data.lastPrune = now;

    if (this.data.actions.length !== before) {
      this.persist();
    }
  }

  // ── Persistence ──────────────────────────────────────────

  private load(): SessionData {
    try {
      if (existsSync(DATA_FILE)) {
        const raw = readFileSync(DATA_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        return {
          actions: Array.isArray(parsed.actions) ? parsed.actions : [],
          lastPrune: parsed.lastPrune || 0,
        };
      }
    } catch {
      // corrupted — start fresh
    }
    return { actions: [], lastPrune: Date.now() };
  }

  private persist(): void {
    try {
      const tmp = DATA_FILE + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
      renameSync(tmp, DATA_FILE);
    } catch {
      try { writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 2), "utf-8"); } catch {}
    }
  }

  private ensureDir(): void {
    if (!existsSync(LAX_DIR)) {
      mkdirSync(LAX_DIR, { recursive: true });
    }
  }
}

export default CrossSessionLearner.getInstance();
