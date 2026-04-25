/**
 * Correction Learning — detects user corrections, records lessons,
 * demotes wrong information and promotes correct facts.
 *
 * Persists to ~/.sax/correction-history.json (max 500 entries).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────

export interface CorrectionEvent {
  wrongInfo: string;
  correctInfo: string;
  context: string;
  sessionId: string;
  timestamp: number;
  confidence: number;
}

export interface CorrectionRecord {
  event: CorrectionEvent;
  lesson: string;
  memoryDemoted?: string;
  memoryPromoted?: string;
}

export interface MistakePattern {
  description: string;
  occurrences: number;
  lastOccurrence: number;
  relatedTopics: string[];
}

interface CorrectionStore {
  records: CorrectionRecord[];
}

// ── Constants ───────────────────────────────────────────────

const LAX_DIR = join(homedir(), ".lax");
const STORE_FILE = join(LAX_DIR, "correction-history.json");
const MAX_RECORDS = 500;

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

function loadStore(): CorrectionStore {
  if (!existsSync(STORE_FILE)) return { records: [] };
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { records: Array.isArray(parsed.records) ? parsed.records : [] };
  } catch {
    return { records: [] };
  }
}

function saveStore(store: CorrectionStore): void {
  ensureDir();
  if (store.records.length > MAX_RECORDS) {
    store.records = store.records.slice(-MAX_RECORDS);
  }
  atomicWrite(STORE_FILE, JSON.stringify(store, null, 2));
}

// ── Detection patterns ──────────────────────────────────────

interface DetectionRule {
  pattern: RegExp;
  extract: (match: RegExpMatchArray, userMsg: string, agentMsg: string) => {
    wrongInfo: string;
    correctInfo: string;
    confidence: number;
  } | null;
}

const DETECTION_RULES: DetectionRule[] = [
  // "no, it's X" / "no it's X"
  {
    pattern: /\bno[,.]?\s+it(?:'|')?s\s+(.+)/i,
    extract: (match, _user, agent) => ({
      wrongInfo: agent.slice(0, 200),
      correctInfo: match[1].replace(/[.!]+$/, "").trim(),
      confidence: 0.8,
    }),
  },
  // "not X, Y" / "not X but Y"
  {
    pattern: /\bnot\s+(.+?)[,]\s*(?:but\s+)?(.+)/i,
    extract: (match) => ({
      wrongInfo: match[1].replace(/[.!]+$/, "").trim(),
      correctInfo: match[2].replace(/[.!]+$/, "").trim(),
      confidence: 0.75,
    }),
  },
  // "not X but Y" (without comma)
  {
    pattern: /\bnot\s+(.+?)\s+but\s+(.+)/i,
    extract: (match) => ({
      wrongInfo: match[1].replace(/[.!]+$/, "").trim(),
      correctInfo: match[2].replace(/[.!]+$/, "").trim(),
      confidence: 0.75,
    }),
  },
  // "I told you X" / "I already said X" / "I already told you X"
  {
    pattern: /\bi\s+(?:already\s+)?(?:told\s+you|said)\s+(.+)/i,
    extract: (match, _user, agent) => ({
      wrongInfo: agent.slice(0, 200),
      correctInfo: match[1].replace(/[.!]+$/, "").trim(),
      confidence: 0.85,
    }),
  },
  // "I meant X" / "I mean X"
  {
    pattern: /\bi\s+mean[t]?\s+(.+)/i,
    extract: (match, _user, agent) => ({
      wrongInfo: agent.slice(0, 200),
      correctInfo: match[1].replace(/[.!]+$/, "").trim(),
      confidence: 0.6,
    }),
  },
  // "wrong" / "incorrect" / "that's not right" / "that's wrong"
  {
    pattern: /\b(?:wrong|incorrect|that(?:'|')?s\s+not\s+right|that(?:'|')?s\s+wrong)\b/i,
    extract: (_match, user, agent) => ({
      wrongInfo: agent.slice(0, 200),
      correctInfo: user.replace(/\b(?:wrong|incorrect|that(?:'|')?s\s+not\s+right|that(?:'|')?s\s+wrong)\b/i, "").trim(),
      confidence: 0.5,
    }),
  },
  // "no" at start of message (simple disagreement)
  {
    pattern: /^no[.,!]?\s+(.+)/i,
    extract: (match, _user, agent) => ({
      wrongInfo: agent.slice(0, 200),
      correctInfo: match[1].replace(/[.!]+$/, "").trim(),
      confidence: 0.55,
    }),
  },
];

// ── Helpers ─────────────────────────────────────────────────

function extractTopics(text: string): string[] {
  // Pull out notable words (capitalized, technical terms, etc.)
  const words = text.split(/\s+/);
  const topics: string[] = [];
  for (const w of words) {
    const clean = w.replace(/[^a-zA-Z0-9_-]/g, "");
    if (clean.length > 3 && clean[0] === clean[0].toUpperCase() && clean[0] !== clean[0].toLowerCase()) {
      topics.push(clean.toLowerCase());
    }
  }
  // Also grab quoted strings
  const quoted = text.match(/["'`]([^"'`]+)["'`]/g);
  if (quoted) {
    for (const q of quoted) {
      topics.push(q.replace(/["'`]/g, "").toLowerCase());
    }
  }
  return [...new Set(topics)];
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().split("T")[0];
}

// ── Class ───────────────────────────────────────────────────

export class CorrectionLearner {
  private static instance: CorrectionLearner | null = null;
  private store: CorrectionStore;

  private constructor() {
    this.store = loadStore();
  }

  static getInstance(): CorrectionLearner {
    if (!CorrectionLearner.instance) {
      CorrectionLearner.instance = new CorrectionLearner();
    }
    return CorrectionLearner.instance;
  }

  /**
   * Detect if a user message is correcting the previous agent message.
   * Returns a CorrectionEvent if a correction is detected, null otherwise.
   */
  detectCorrection(userMessage: string, previousAgentMessage: string): CorrectionEvent | null {
    const trimmed = userMessage.trim();
    if (trimmed.length < 2) return null;

    for (const rule of DETECTION_RULES) {
      const match = trimmed.match(rule.pattern);
      if (match) {
        const result = rule.extract(match, trimmed, previousAgentMessage);
        if (result && result.correctInfo.length > 0) {
          return {
            wrongInfo: result.wrongInfo,
            correctInfo: result.correctInfo,
            context: previousAgentMessage.slice(0, 300),
            sessionId: "",
            timestamp: Date.now(),
            confidence: result.confidence,
          };
        }
      }
    }

    return null;
  }

  /**
   * Record a correction: log it, create a lesson, and track demotion/promotion.
   */
  recordCorrection(correction: CorrectionEvent): void {
    const lesson = `Previously thought "${correction.wrongInfo.slice(0, 80)}" ` +
      `but user corrected to "${correction.correctInfo.slice(0, 80)}" ` +
      `on ${formatDate(correction.timestamp)}`;

    const record: CorrectionRecord = {
      event: correction,
      lesson,
      memoryDemoted: correction.wrongInfo.slice(0, 100),
      memoryPromoted: correction.correctInfo.slice(0, 100),
    };

    this.store.records.push(record);
    saveStore(this.store);
  }

  /**
   * Return all correction records.
   */
  getCorrectionHistory(): CorrectionRecord[] {
    return [...this.store.records];
  }

  /**
   * Identify patterns in what the agent frequently gets wrong.
   */
  getFrequentMistakes(): MistakePattern[] {
    // Group corrections by topic similarity
    const groups: Map<string, CorrectionRecord[]> = new Map();

    for (const record of this.store.records) {
      const topics = extractTopics(record.event.wrongInfo + " " + record.event.correctInfo);
      const key = topics.sort().join("|") || "general";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(record);
    }

    const patterns: MistakePattern[] = [];

    for (const [key, records] of groups.entries()) {
      if (records.length < 2) continue;

      // Build a description from the most common correction
      const wrongs = records.map((r) => r.event.wrongInfo.slice(0, 60));
      const corrects = records.map((r) => r.event.correctInfo.slice(0, 60));

      const description = `Agent repeatedly confused "${wrongs[0]}" — ` +
        `correct answer is "${corrects[corrects.length - 1]}"`;

      patterns.push({
        description,
        occurrences: records.length,
        lastOccurrence: Math.max(...records.map((r) => r.event.timestamp)),
        relatedTopics: key === "general" ? [] : key.split("|"),
      });
    }

    patterns.sort((a, b) => b.occurrences - a.occurrences);
    return patterns;
  }

  /**
   * Before answering about a topic, check if there are known corrections.
   * Returns a note about past corrections or null.
   */
  getCorrectiveContext(topic: string): string | null {
    const lower = topic.toLowerCase();
    const relevant: CorrectionRecord[] = [];

    for (const record of this.store.records) {
      const full = (
        record.event.wrongInfo + " " +
        record.event.correctInfo + " " +
        record.event.context + " " +
        record.lesson
      ).toLowerCase();

      if (full.includes(lower)) {
        relevant.push(record);
      }
    }

    if (relevant.length === 0) return null;

    // Return the most recent relevant correction
    relevant.sort((a, b) => b.event.timestamp - a.event.timestamp);
    const latest = relevant[0];

    return `Note: user previously corrected you on this — ` +
      `"${latest.event.correctInfo}" (not "${latest.event.wrongInfo.slice(0, 60)}"). ` +
      `Correction from ${formatDate(latest.event.timestamp)}.`;
  }
}
