/**
 * Unspoken Detector — notice what's NOT being said.
 *
 * Tracks topic and entity frequency across conversations, then flags
 * significant absences. If someone who was mentioned daily suddenly
 * disappears from conversation, something may have changed. The agent
 * gets a gentle sensitivity hint without specifics.
 *
 * Persists to ~/.sax/topic-frequencies.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────

export interface Absence {
  entity: string;
  type: "topic" | "entity" | "activity";
  usualFrequency: number;
  recentFrequency: number;
  daysSinceLastMention: number;
  significance: "low" | "medium" | "high";
}

export interface BehaviorChange {
  type: string;
  description: string;
  before: string;
  after: string;
  confidence: number;
}

interface EntityRecord {
  name: string;
  type: "topic" | "entity" | "activity";
  mentions: { timestamp: number; sessionId: string }[];
}

interface SessionMeta {
  sessionId: string;
  timestamp: number;
  timeOfDay: number;   // 0-23
  messageCount: number;
  avgMessageLength: number;
  toneSignals: string[];
}

interface FrequencyStore {
  entities: EntityRecord[];
  sessions: SessionMeta[];
}

// ── Persistence ─────────────────────────────────────────────

const SAX_DIR = join(homedir(), ".sax");
const STORE_FILE = join(SAX_DIR, "topic-frequencies.json");
const MAX_ENTITIES = 500;
const MAX_SESSIONS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

function ensureDir(): void {
  if (!existsSync(SAX_DIR)) mkdirSync(SAX_DIR, { recursive: true });
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

function loadStore(): FrequencyStore {
  if (!existsSync(STORE_FILE)) return { entities: [], sessions: [] };
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return { entities: [], sessions: [] };
  }
}

function saveStore(store: FrequencyStore): void {
  ensureDir();
  // Enforce limits
  if (store.entities.length > MAX_ENTITIES) {
    // Keep the most recently mentioned entities
    store.entities.sort((a, b) => {
      const aLast = a.mentions.length > 0 ? a.mentions[a.mentions.length - 1].timestamp : 0;
      const bLast = b.mentions.length > 0 ? b.mentions[b.mentions.length - 1].timestamp : 0;
      return bLast - aLast;
    });
    store.entities = store.entities.slice(0, MAX_ENTITIES);
  }
  if (store.sessions.length > MAX_SESSIONS) {
    store.sessions = store.sessions.slice(-MAX_SESSIONS);
  }
  atomicWrite(STORE_FILE, JSON.stringify(store, null, 2));
}

// ── UnspokenDetector ────────────────────────────────────────

export class UnspokenDetector {
  private static instance: UnspokenDetector | null = null;

  private constructor() {}

  static getInstance(): UnspokenDetector {
    if (!UnspokenDetector.instance) {
      UnspokenDetector.instance = new UnspokenDetector();
    }
    return UnspokenDetector.instance;
  }

  /**
   * Record topic and entity frequency for a session.
   */
  recordTopicFrequency(sessionId: string, topics: string[], entities: string[]): void {
    const store = loadStore();
    const ts = Date.now();

    const allItems: { name: string; type: "topic" | "entity" }[] = [
      ...topics.map((t) => ({ name: t.toLowerCase(), type: "topic" as const })),
      ...entities.map((e) => ({ name: e, type: "entity" as const })),
    ];

    for (const item of allItems) {
      let record = store.entities.find(
        (r) => r.name.toLowerCase() === item.name.toLowerCase() && r.type === item.type
      );

      if (!record) {
        record = { name: item.name, type: item.type, mentions: [] };
        store.entities.push(record);
      }

      record.mentions.push({ timestamp: ts, sessionId });
    }

    saveStore(store);
  }

  /**
   * Detect entities/topics that have gone silent.
   * Compares recent 7 days to historical 90-day pattern.
   */
  detectAbsence(): Absence[] {
    const store = loadStore();
    const now = Date.now();
    const recentCutoff = now - 7 * DAY_MS;
    const historicalCutoff = now - 90 * DAY_MS;

    const absences: Absence[] = [];

    for (const record of store.entities) {
      // Only consider entities with enough historical data
      const historicalMentions = record.mentions.filter(
        (m) => m.timestamp >= historicalCutoff && m.timestamp < recentCutoff
      );
      const recentMentions = record.mentions.filter(
        (m) => m.timestamp >= recentCutoff
      );

      if (historicalMentions.length < 3) continue;

      // Calculate frequency: mentions per day
      const historicalDays = Math.max(1, (recentCutoff - historicalCutoff) / DAY_MS);
      const recentDays = Math.max(1, (now - recentCutoff) / DAY_MS);

      const usualFreq = historicalMentions.length / historicalDays;
      const recentFreq = recentMentions.length / recentDays;

      // Calculate days since last mention
      const allTimestamps = record.mentions.map((m) => m.timestamp);
      const lastMention = Math.max(...allTimestamps);
      const daysSince = Math.floor((now - lastMention) / DAY_MS);

      // Determine if this is a significant drop
      if (recentFreq < usualFreq * 0.2) {
        let significance: "low" | "medium" | "high" = "low";

        if (usualFreq >= 0.5 && daysSince >= 14) {
          significance = "high";
        } else if (usualFreq >= 0.3 && daysSince >= 7) {
          significance = "medium";
        } else if (usualFreq >= 0.1 && daysSince >= 7) {
          significance = "low";
        } else {
          continue; // Not significant enough
        }

        absences.push({
          entity: record.name,
          type: record.type,
          usualFrequency: Math.round(usualFreq * 100) / 100,
          recentFrequency: Math.round(recentFreq * 100) / 100,
          daysSinceLastMention: daysSince,
          significance,
        });
      }
    }

    // Sort by significance (high first) then by days since mention
    const sigOrder = { high: 0, medium: 1, low: 2 };
    absences.sort((a, b) => {
      const sigDiff = sigOrder[a.significance] - sigOrder[b.significance];
      if (sigDiff !== 0) return sigDiff;
      return b.daysSinceLastMention - a.daysSinceLastMention;
    });

    return absences;
  }

  /**
   * Generate a gentle sensitivity hint without mentioning specifics.
   * Only for high-significance absences.
   */
  getSensitivityHint(absences: Absence[]): string {
    const highAbsences = absences.filter((a) => a.significance === "high");
    if (highAbsences.length === 0) return "";

    const hints = [
      "Be a little more gentle and attentive today.",
      "Take a softer approach in this conversation.",
      "Be especially warm and present right now.",
      "Listen a little more carefully today.",
      "Be extra thoughtful with responses today.",
    ];

    // Deterministic but varied selection based on date
    const dayIndex = Math.floor(Date.now() / DAY_MS) % hints.length;
    return hints[dayIndex];
  }

  /**
   * Detect behavioral changes: time of day, conversation length, tone.
   */
  detectBehaviorChange(): BehaviorChange[] {
    const store = loadStore();
    const now = Date.now();
    const recentCutoff = now - 14 * DAY_MS;
    const olderCutoff = now - 60 * DAY_MS;

    const recentSessions = store.sessions.filter((s) => s.timestamp >= recentCutoff);
    const olderSessions = store.sessions.filter(
      (s) => s.timestamp >= olderCutoff && s.timestamp < recentCutoff
    );

    if (recentSessions.length < 3 || olderSessions.length < 5) return [];

    const changes: BehaviorChange[] = [];

    // Time of day change
    const avgOlderTime = this.average(olderSessions.map((s) => s.timeOfDay));
    const avgRecentTime = this.average(recentSessions.map((s) => s.timeOfDay));
    const timeDiff = Math.abs(avgRecentTime - avgOlderTime);

    if (timeDiff >= 3) {
      const beforeLabel = this.timeLabel(avgOlderTime);
      const afterLabel = this.timeLabel(avgRecentTime);
      changes.push({
        type: "time-of-day",
        description: `Conversation time shifted from ${beforeLabel} to ${afterLabel}`,
        before: beforeLabel,
        after: afterLabel,
        confidence: Math.min(1, timeDiff / 6),
      });
    }

    // Message length change
    const avgOlderLen = this.average(olderSessions.map((s) => s.avgMessageLength));
    const avgRecentLen = this.average(recentSessions.map((s) => s.avgMessageLength));

    if (avgOlderLen > 0) {
      const lenRatio = avgRecentLen / avgOlderLen;
      if (lenRatio < 0.5) {
        changes.push({
          type: "message-length",
          description: "Messages have gotten noticeably shorter",
          before: `~${Math.round(avgOlderLen)} chars`,
          after: `~${Math.round(avgRecentLen)} chars`,
          confidence: Math.min(1, (1 - lenRatio) * 1.5),
        });
      } else if (lenRatio > 2) {
        changes.push({
          type: "message-length",
          description: "Messages have gotten noticeably longer",
          before: `~${Math.round(avgOlderLen)} chars`,
          after: `~${Math.round(avgRecentLen)} chars`,
          confidence: Math.min(1, (lenRatio - 1) * 0.5),
        });
      }
    }

    // Conversation count change
    const olderDays = Math.max(1, (recentCutoff - olderCutoff) / DAY_MS);
    const recentDays = Math.max(1, (now - recentCutoff) / DAY_MS);
    const olderRate = olderSessions.length / olderDays;
    const recentRate = recentSessions.length / recentDays;

    if (olderRate > 0) {
      const freqRatio = recentRate / olderRate;
      if (freqRatio < 0.4) {
        changes.push({
          type: "conversation-frequency",
          description: "Chatting less often than usual",
          before: `~${(olderRate * 7).toFixed(1)}/week`,
          after: `~${(recentRate * 7).toFixed(1)}/week`,
          confidence: Math.min(1, (1 - freqRatio) * 1.2),
        });
      }
    }

    return changes;
  }

  /**
   * Record session metadata for behavior tracking.
   */
  recordSession(sessionId: string, messageCount: number, avgMessageLength: number, toneSignals: string[]): void {
    const store = loadStore();
    const now_ts = Date.now();
    const hour = new Date(now_ts).getHours();

    store.sessions.push({
      sessionId,
      timestamp: now_ts,
      timeOfDay: hour,
      messageCount,
      avgMessageLength,
      toneSignals,
    });

    saveStore(store);
  }

  // ── Private helpers ─────────────────────────────────────────

  private average(nums: number[]): number {
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  private timeLabel(hour: number): string {
    if (hour < 6) return "late night";
    if (hour < 12) return "morning";
    if (hour < 17) return "afternoon";
    if (hour < 21) return "evening";
    return "late night";
  }
}
