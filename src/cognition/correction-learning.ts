/**
 * Correction Learning — detects user corrections, records lessons,
 * demotes wrong information and promotes correct facts.
 *
 * Persists to ~/.lax/correction-history.json (max 500 entries).
 */

import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createJsonStore } from "../util/json-store.js";
import { classifyYesNo } from "../classifiers/classify-with-llm.js";
import {
  CORRECTION_PREGATE,
  DETECTION_RULES,
  extractTopics,
  formatDate,
} from "./correction-learning-detect.js";

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

interface CorrectionStore extends Record<string, unknown> {
  records: CorrectionRecord[];
}

// ── Constants ───────────────────────────────────────────────

const LAX_DIR = getLaxDir();
const STORE_FILE = join(LAX_DIR, "correction-history.json");
const MAX_RECORDS = 500;

// ── LLM confirm (gate → confirm → fail-open) ────────────────
//
// The regex DETECTION_RULES are lexicon/paraphrase-blind: they fire on the
// SHAPE of a message ("no, it's X", "not X but Y") without understanding
// whether the user is actually overriding something the agent said. A false
// positive here is uniquely costly — recordCorrection() writes a DURABLE
// "lesson" to ~/.lax/correction-history.json that later injects "user
// previously corrected you…" into prompts, so a wrong lesson poisons future
// turns. Same shape as instruction-ledger/extract.ts and the C1
// operational-claim middleware: the regex is the cheap PREFILTER; an LLM
// confirm vetoes false positives before the PERSIST.
//
// FAIL-OPEN: only an explicit NO skips the persist. null / timeout /
// LAX_LLM_CORRECTION_LEARNING=0 all PERSIST — parity with today's behavior,
// because silently dropping a real correction on an LLM outage is worse than
// an occasional false one (today records unconditionally).

/** Confirms the candidate correction, or null when unavailable (→ persist). */
export type ConfirmCorrectionFn = (
  userMessage: string,
  agentMessage: string,
) => Promise<boolean | null>;

const CONFIRM_SYSTEM_PROMPT = `A regex prefilter flagged ONE user message as possibly CORRECTING or OVERRIDING something an AI assistant just said. You decide whether that flag is real before a durable "lesson" is written to memory.

Reply YES only when the user is actually correcting, contradicting, or overriding a previous statement or instruction — telling the assistant it was wrong about a fact, or restating what they really meant.

Reply NO when the flag is a false positive:
- The user is asking a question, giving a new unrelated instruction, or continuing the task.
- Words like "no", "not", "wrong", "actually", "I meant" appear in ordinary prose that isn't correcting the assistant (e.g. "no problem", "not sure yet", "actually that's great").
- The message negates or discusses something OTHER than what the assistant asserted.
- The message agrees with or merely acknowledges the assistant.

Judge the user message against the assistant's previous message. Reply with EXACTLY one line, starting with YES or NO followed by a brief reason.
YES = a real correction, record it.
NO = false positive, do not record.`;

const DEFAULT_CONFIRM: ConfirmCorrectionFn = (userMessage, agentMessage) =>
  classifyYesNo({
    category: "correction-learning-confirm",
    systemPrompt: CONFIRM_SYSTEM_PROMPT,
    userPrompt:
      `Assistant's previous message:\n"${agentMessage.slice(0, 1500)}"\n\n` +
      `User's message:\n"${userMessage.slice(0, 1500)}"\n\n` +
      `Is the user actually correcting or overriding a previous statement or instruction here? Reply YES or NO + one-line reason.`,
    timeoutMs: 4000,
    envDisableVar: "LAX_LLM_CORRECTION_LEARNING",
  });

// ── Persistence ─────────────────────────────────────────────

const jsonStore = createJsonStore<CorrectionStore>(STORE_FILE, {
  defaults: () => ({ records: [] }),
  caps: { records: MAX_RECORDS },
});

// ── Class ───────────────────────────────────────────────────

export class CorrectionLearner {
  private static instance: CorrectionLearner | null = null;
  private store: CorrectionStore;

  private constructor() {
    this.store = jsonStore.load();
  }

  static getInstance(): CorrectionLearner {
    if (!CorrectionLearner.instance) {
      CorrectionLearner.instance = new CorrectionLearner();
    }
    return CorrectionLearner.instance;
  }

  /** Pre-gate: does this message look like it might be correcting the agent? */
  static looksLikeCorrection(message: string): boolean {
    return CORRECTION_PREGATE.test(message);
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
    jsonStore.save(this.store);
  }

  /**
   * Persist a candidate correction ONLY after an LLM confirms it's a real
   * correction. The regex DETECTION_RULES that produced `correction` are
   * paraphrase-blind (a bare "no …" or "not X, Y" shape fires without knowing
   * the user is overriding the agent), so this is the precision gate on the
   * one path that writes durable memory.
   *
   *   confirm === true  → recordCorrection() persists as today.
   *   confirm === false → skip the persist (THE FIX — false positives no
   *                       longer poison correction-history.json).
   *   confirm === null  → PERSIST (fail-open parity: LLM unavailable/timeout/
   *                       disabled must not silently drop a real correction).
   *
   * `confirm` is an injectable default param (same shape as extract.ts) so
   * tests pin the verdict without touching the network. Never throws — a
   * confirmer error is treated exactly like a null verdict.
   */
  async recordCorrectionMaybe(
    correction: CorrectionEvent,
    userMessage: string,
    agentMessage: string,
    confirm: ConfirmCorrectionFn = DEFAULT_CONFIRM,
  ): Promise<boolean> {
    let verdict: boolean | null = null;
    try {
      verdict = await confirm(userMessage, agentMessage);
    } catch {
      verdict = null; // fail open — treated exactly like an LLM timeout
    }
    if (verdict === false) return false; // confirmed false positive — skip
    this.recordCorrection(correction);
    return true;
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
