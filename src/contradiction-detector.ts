/**
 * Local Agent X — Contradiction Detector
 *
 * Detects and resolves conflicting facts about the same entity.
 * Handles location, employment, preference, status, and numeric
 * contradictions using keyword overlap and entity matching.
 *
 * Persists contradiction history to ~/.lax/contradiction-history.json.
 */

import { getLaxDir } from "./lax-data-dir.js";
import { getUniversalIndex } from "./memory/universal-index.js";
import type { ModuleSignal } from "./orchestrator/types.js";
import {
  FACT_PATTERNS,
  FIELD_PATTERNS,
  getEntity,
  keywordOverlap,
} from "./contradiction-patterns.js";
import type {
  Contradiction,
  ContradictionRecord,
  Resolution,
} from "./contradiction-patterns.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type {
  Contradiction,
  ContradictionRecord,
  Resolution,
} from "./contradiction-patterns.js";

// ══════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════

const LAX_DIR = getLaxDir();
const HISTORY_FILE = join(LAX_DIR, "contradiction-history.json");

// ══════════════════════════════════════════════════════════
//  ContradictionDetector (singleton)
// ══════════════════════════════════════════════════════════

export class ContradictionDetector {
  private static instance: ContradictionDetector;
  private history: ContradictionRecord[];

  private constructor() {
    if (!existsSync(LAX_DIR)) mkdirSync(LAX_DIR, { recursive: true });
    this.history = this.loadHistory();
  }

  static getInstance(): ContradictionDetector {
    if (!ContradictionDetector.instance) {
      ContradictionDetector.instance = new ContradictionDetector();
    }
    return ContradictionDetector.instance;
  }

  /** Pre-gate: does this message assert a fact worth checking against the user's record? */
  static looksLikeFactStatement(message: string): boolean {
    return FACT_PATTERNS.some(p => p.test(message));
  }

  // ── Check a single new fact against existing facts ────────

  checkContradiction(
    newFact: string,
    existingFacts: string[]
  ): Contradiction | null {
    const newEntity = getEntity(newFact);

    for (const existing of existingFacts) {
      const existingEntity = getEntity(existing);

      // Entity match: both must reference the same entity (or share high overlap)
      const entityMatch =
        (newEntity && existingEntity && newEntity === existingEntity) ||
        keywordOverlap(newFact, existing) > 0.4;

      if (!entityMatch) continue;

      // Check each field pattern
      for (const fp of FIELD_PATTERNS) {
        const newValue = fp.extractValue(newFact);
        const oldValue = fp.extractValue(existing);

        if (newValue && oldValue && newValue.toLowerCase() !== oldValue.toLowerCase()) {
          return {
            oldFact: existing,
            newFact,
            entity: newEntity || existingEntity || undefined,
            field: fp.field,
            confidence: this.computeConfidence(newFact, existing, fp.field),
            detectedAt: Date.now(),
          };
        }
      }
    }

    return null;
  }

  // ── Orchestrator signal ───────────────────────────────────

  /**
   * Signal a contradiction between the message and the user's accumulated facts.
   *
   * Pulls live facts from the Facts DB rather than this.getContradictionHistory()
   * — its own log of past contradictions. The auto-recording path was unreliable,
   * so that comparison set was almost always empty and the detector never fired.
   * Reading the Facts DB means the detector actually sees the user's accumulated
   * preferences when they say "stop X" / "don't do X anymore".
   */
  signalsFor(message: string): ModuleSignal[] {
    let factTexts: string[] = [];
    try {
      const memory = getUniversalIndex()?.getMemory();
      if (memory) {
        factTexts = memory.recallRecentFacts({ limit: 100, minConfidence: 0.4 }).map(f => f.content);
      }
    } catch { /* facts unavailable — fall through to no-op */ }
    if (factTexts.length === 0) return [];
    const contradiction = this.checkContradiction(message, factTexts);
    if (!contradiction) return [];
    return [{
      source: "contradiction-detector",
      signal:
        `Possible contradiction with prior fact: "${contradiction.oldFact}" — ` +
        `user just said "${contradiction.newFact}". Call \`forget\` or \`update_fact\` ` +
        `to retire the stale fact, don't just save a new one alongside it.`,
      priority: 9,
      category: "contradiction",
      confidence: contradiction.confidence,
    }];
  }

  // ── Resolve a detected contradiction ──────────────────────

  resolveContradiction(
    contradiction: Contradiction,
    strategy: "newest-wins" | "ask-user" | "keep-both" = "newest-wins"
  ): Resolution {
    let resolution: Resolution;

    switch (strategy) {
      case "newest-wins":
        resolution = {
          action: "replaced",
          updatedFact: contradiction.newFact,
          archivedFact: contradiction.oldFact,
        };
        break;

      case "ask-user":
        resolution = {
          action: "pending-user-decision",
          updatedFact: contradiction.newFact,
          archivedFact: contradiction.oldFact,
        };
        break;

      case "keep-both": {
        const combined = `Previously: ${contradiction.oldFact}. Now: ${contradiction.newFact}`;
        resolution = {
          action: "merged-timeline",
          updatedFact: combined,
          archivedFact: undefined,
        };
        break;
      }
    }

    // Record the resolution
    this.history.push({
      contradiction,
      resolution,
      timestamp: Date.now(),
    });
    this.saveHistory();

    return resolution;
  }

  // ── Get full contradiction history ────────────────────────

  getContradictionHistory(): ContradictionRecord[] {
    return [...this.history];
  }

  // ── Batch detection across a set of facts ─────────────────

  detectBatchContradictions(facts: string[]): Contradiction[] {
    const contradictions: Contradiction[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < facts.length; i++) {
      const others = facts.filter((_, j) => j !== i);
      const c = this.checkContradiction(facts[i], others);
      if (c) {
        // De-duplicate (A vs B same as B vs A)
        const key = [c.oldFact, c.newFact].sort().join("|||");
        if (!seen.has(key)) {
          seen.add(key);
          contradictions.push(c);
        }
      }
    }

    return contradictions;
  }

  // ── Private helpers ───────────────────────────────────────

  private computeConfidence(
    newFact: string,
    oldFact: string,
    field: string
  ): number {
    let confidence = 0.5;

    // Higher overlap in non-value keywords = higher confidence in contradiction
    const overlap = keywordOverlap(newFact, oldFact);
    confidence += overlap * 0.3;

    // Certain fields are more reliable indicators
    if (field === "location" || field === "employment") {
      confidence += 0.1;
    }

    return Math.min(1, Math.max(0, confidence));
  }

  private loadHistory(): ContradictionRecord[] {
    try {
      if (existsSync(HISTORY_FILE)) {
        return JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
      }
    } catch {
      // Corrupt — start fresh
    }
    return [];
  }

  private saveHistory(): void {
    // Keep last 500 entries
    const trimmed = this.history.slice(-500);
    writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
  }
}
