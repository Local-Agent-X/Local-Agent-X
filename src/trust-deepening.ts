/**
 * Trust Deepening — Relationship evolves over time.
 *
 * Tracks positive and negative interaction signals to compute a continuous
 * trust score and trust level that governs how casual, proactive, and
 * personal the agent can be.
 *
 * Persists to ~/.lax/trust-engine.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getLaxDir } from "./lax-data-dir.js";

// ── Types ────────────────────────────────────────────────────

export type TrustLevel = "new" | "familiar" | "trusted" | "close" | "best-friend";

export type PositiveSignal = "praise" | "agreement" | "personal-share" | "long-session" | "return-visit";
export type NegativeSignal = "correction" | "frustration" | "distrust" | "short-session";

export interface TrustAdjustments {
  formality: number;       // 0 = very casual, 1 = very formal
  initiative: number;      // 0 = never, 1 = always take initiative
  assumptions: boolean;    // whether to make assumptions about preferences
  callbacks: boolean;      // whether to reference past conversations
  personalReferences: boolean; // whether to make personal references
}

interface SignalEntry {
  type: PositiveSignal | NegativeSignal;
  positive: boolean;
  timestamp: number;
  weight: number;
}

interface TrustStore {
  firstSeen: number;
  signals: SignalEntry[];
  conversationCount: number;
  successfulTasks: number;
  lastInteraction: number;
}

// ── Constants ───────────────────────────────────────────────

const LAX_DIR = getLaxDir();
const STORE_FILE = join(LAX_DIR, "trust-engine.json");
const MAX_SIGNALS = 1000;

const POSITIVE_WEIGHTS: Record<PositiveSignal, number> = {
  "praise": 3,
  "agreement": 1,
  "personal-share": 4,
  "long-session": 2,
  "return-visit": 2,
};

const NEGATIVE_WEIGHTS: Record<NegativeSignal, number> = {
  "correction": -2,
  "frustration": -3,
  "distrust": -5,
  "short-session": -1,
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

function loadStore(): TrustStore {
  if (!existsSync(STORE_FILE)) {
    return {
      firstSeen: Date.now(),
      signals: [],
      conversationCount: 0,
      successfulTasks: 0,
      lastInteraction: Date.now(),
    };
  }
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      firstSeen: parsed.firstSeen ?? Date.now(),
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
      conversationCount: parsed.conversationCount ?? 0,
      successfulTasks: parsed.successfulTasks ?? 0,
      lastInteraction: parsed.lastInteraction ?? Date.now(),
    };
  } catch {
    return {
      firstSeen: Date.now(),
      signals: [],
      conversationCount: 0,
      successfulTasks: 0,
      lastInteraction: Date.now(),
    };
  }
}

function saveStore(store: TrustStore): void {
  ensureDir();
  if (store.signals.length > MAX_SIGNALS) {
    store.signals = store.signals.slice(-MAX_SIGNALS);
  }
  atomicWrite(STORE_FILE, JSON.stringify(store, null, 2));
}

// ── Helpers ─────────────────────────────────────────────────

function daysSince(ts: number): number {
  return Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
}

// ── TrustEngine class ───────────────────────────────────────

export class TrustEngine {
  private static instance: TrustEngine | null = null;
  private store: TrustStore;

  private constructor() {
    this.store = loadStore();
  }

  static getInstance(): TrustEngine {
    if (!TrustEngine.instance) TrustEngine.instance = new TrustEngine();
    return TrustEngine.instance;
  }

  /** Calculate the current trust level based on all factors. */
  calculateTrustLevel(): TrustLevel {
    const score = this.getTrustScore();
    const days = daysSince(this.store.firstSeen);

    // Time gates — can be accelerated by high scores
    if (days < 7 && score < 30) return "new";
    if (days < 30 && score < 50) return "familiar";
    if (days < 90 && score < 70) return "trusted";
    if (days < 180 && score < 85) return "close";

    // Score can accelerate past time gates
    if (score >= 85) return "best-friend";
    if (score >= 70) return "close";
    if (score >= 50) return "trusted";
    if (score >= 30) return "familiar";
    return "new";
  }

  /** Continuous trust score from 0-100. */
  getTrustScore(): number {
    const days = daysSince(this.store.firstSeen);

    // Base score from time (max 30 points)
    const timeScore = Math.min(30, days * 0.15);

    // Signal score (max 40 points)
    let signalSum = 0;
    const now = Date.now();
    for (const sig of this.store.signals) {
      // Recent signals count more — decay over 90 days
      const age = (now - sig.timestamp) / (1000 * 60 * 60 * 24);
      const decay = Math.max(0.1, 1 - age / 90);
      signalSum += sig.weight * decay;
    }
    // Normalize: clamp to [-20, 40] range then shift to [0, 40]
    const signalScore = Math.max(0, Math.min(40, signalSum + 20));

    // Engagement score (max 20 points) — based on conversation count
    const engagementScore = Math.min(20, this.store.conversationCount * 0.1);

    // Task success score (max 10 points)
    const taskScore = Math.min(10, this.store.successfulTasks * 0.2);

    return Math.round(Math.min(100, timeScore + signalScore + engagementScore + taskScore));
  }

  /** Get behavior adjustments based on the current trust level. */
  getBehaviorAdjustments(): TrustAdjustments {
    const level = this.calculateTrustLevel();

    switch (level) {
      case "new":
        return { formality: 0.8, initiative: 0.1, assumptions: false, callbacks: false, personalReferences: false };
      case "familiar":
        return { formality: 0.6, initiative: 0.3, assumptions: false, callbacks: true, personalReferences: false };
      case "trusted":
        return { formality: 0.4, initiative: 0.6, assumptions: true, callbacks: true, personalReferences: false };
      case "close":
        return { formality: 0.2, initiative: 0.8, assumptions: true, callbacks: true, personalReferences: true };
      case "best-friend":
        return { formality: 0.1, initiative: 1.0, assumptions: true, callbacks: true, personalReferences: true };
    }
  }

  /** Record a positive interaction signal. */
  recordPositiveSignal(type: PositiveSignal): void {
    this.store.signals.push({
      type,
      positive: true,
      timestamp: Date.now(),
      weight: POSITIVE_WEIGHTS[type],
    });
    this.store.lastInteraction = Date.now();
    saveStore(this.store);
  }

  /** Record a negative interaction signal. */
  recordNegativeSignal(type: NegativeSignal): void {
    this.store.signals.push({
      type,
      positive: false,
      timestamp: Date.now(),
      weight: NEGATIVE_WEIGHTS[type],
    });
    this.store.lastInteraction = Date.now();
    saveStore(this.store);
  }

  /** Increment conversation count. */
  recordConversation(): void {
    this.store.conversationCount++;
    this.store.lastInteraction = Date.now();
    saveStore(this.store);
  }

  /** Increment successful task count. */
  recordTaskSuccess(): void {
    this.store.successfulTasks++;
    saveStore(this.store);
  }

  /** Get a natural-language description of the current relationship stage. */
  getRelationshipStage(): string {
    const level = this.calculateTrustLevel();
    const days = daysSince(this.store.firstSeen);
    const convos = this.store.conversationCount;

    switch (level) {
      case "new":
        return `We're just getting started — ${days} day${days !== 1 ? "s" : ""} in, ${convos} conversation${convos !== 1 ? "s" : ""}. Still learning your preferences.`;
      case "familiar":
        return `Getting comfortable — ${days} days together, ${convos} conversations. Starting to learn your style and workflow.`;
      case "trusted":
        return `Solid working relationship — ${days} days, ${convos} conversations. I know your preferences and can take initiative when it makes sense.`;
      case "close":
        return `We go way back — ${days} days, ${convos}+ conversations. I know your style, your preferences, and can anticipate what you need.`;
      case "best-friend":
        return `Ride or die — ${days} days together, ${convos}+ conversations. Full trust, full autonomy, full vibes.`;
    }
  }

  /** Reload store from disk. */
  reload(): void {
    this.store = loadStore();
  }

  /** Reset singleton (testing). */
  static reset(): void {
    TrustEngine.instance = null;
  }
}
