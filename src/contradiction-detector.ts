/**
 * Open Agent X — Contradiction Detector
 *
 * Detects and resolves conflicting facts about the same entity.
 * Handles location, employment, preference, status, and numeric
 * contradictions using keyword overlap and entity matching.
 *
 * Persists contradiction history to ~/.lax/contradiction-history.json.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ══════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════

export interface Contradiction {
  oldFact: string;
  newFact: string;
  entity?: string;
  field?: string;
  confidence: number;
  detectedAt: number;
}

export interface Resolution {
  action: string;
  updatedFact: string;
  archivedFact?: string;
}

export interface ContradictionRecord {
  contradiction: Contradiction;
  resolution: Resolution;
  timestamp: number;
}

// ══════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════

const LAX_DIR = join(homedir(), ".lax");
const HISTORY_FILE = join(LAX_DIR, "contradiction-history.json");

// ── Keyword patterns for contradiction categories ────────

interface FieldPattern {
  field: string;
  patterns: RegExp[];
  /** Extract the value portion from a matching fact */
  extractValue: (text: string) => string | null;
}

const FIELD_PATTERNS: FieldPattern[] = [
  {
    field: "location",
    patterns: [
      /\b(lives?\s+in)\s+(.+?)(?:\.|,|$)/i,
      /\b(moved?\s+to)\s+(.+?)(?:\.|,|$)/i,
      /\b(based\s+in)\s+(.+?)(?:\.|,|$)/i,
      /\b(from)\s+(.+?)(?:\.|,|$)/i,
      /\b(relocated\s+to)\s+(.+?)(?:\.|,|$)/i,
    ],
    extractValue(text: string): string | null {
      for (const p of this.patterns) {
        const m = text.match(p);
        if (m) return m[2].trim();
      }
      return null;
    },
  },
  {
    field: "employment",
    patterns: [
      /\b(works?\s+at)\s+(.+?)(?:\.|,|$)/i,
      /\b(works?\s+for)\s+(.+?)(?:\.|,|$)/i,
      /\b(job\s+is)\s+(.+?)(?:\.|,|$)/i,
      /\b(hired\s+at)\s+(.+?)(?:\.|,|$)/i,
      /\b(left)\s+(.+?)(?:\.|,|$)/i,
      /\b(joined)\s+(.+?)(?:\.|,|$)/i,
    ],
    extractValue(text: string): string | null {
      for (const p of this.patterns) {
        const m = text.match(p);
        if (m) return m[2].trim();
      }
      return null;
    },
  },
  {
    field: "preference",
    patterns: [
      /\b(likes?)\s+(.+?)(?:\.|,|$)/i,
      /\b(loves?)\s+(.+?)(?:\.|,|$)/i,
      /\b(hates?)\s+(.+?)(?:\.|,|$)/i,
      /\b(prefers?)\s+(.+?)(?:\.|,|$)/i,
      /\b(favorite\s+\w+\s+is)\s+(.+?)(?:\.|,|$)/i,
      /\b(dislikes?)\s+(.+?)(?:\.|,|$)/i,
    ],
    extractValue(text: string): string | null {
      for (const p of this.patterns) {
        const m = text.match(p);
        if (m) return m[2].trim();
      }
      return null;
    },
  },
  {
    field: "status",
    patterns: [
      /\b(is\s+married)/i,
      /\b(is\s+single)/i,
      /\b(is\s+dating)/i,
      /\b(has\s+\d+\s+kids?)/i,
      /\b(has\s+\d+\s+children)/i,
      /\b(divorced)/i,
      /\b(engaged)/i,
    ],
    extractValue(text: string): string | null {
      for (const p of this.patterns) {
        const m = text.match(p);
        if (m) return m[1].trim();
      }
      return null;
    },
  },
  {
    field: "numeric",
    patterns: [
      /\b(\d+(?:\.\d+)?)\s*(years?\s+old|kg|lbs?|miles?|dollars?|employees?|people|members?)/i,
    ],
    extractValue(text: string): string | null {
      const m = text.match(
        /\b(\d+(?:\.\d+)?)\s*(years?\s+old|kg|lbs?|miles?|dollars?|employees?|people|members?)/i
      );
      return m ? `${m[1]} ${m[2]}` : null;
    },
  },
];

// ══════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════

function extractEntity(text: string): string | null {
  const m = text.match(/@([\w-]+)/);
  return m ? m[1].toLowerCase() : null;
}

function entityFromContext(text: string): string | null {
  // Try to find a capitalized proper noun as entity
  const m = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/);
  return m ? m[1].toLowerCase() : null;
}

function getEntity(text: string): string | null {
  return extractEntity(text) || entityFromContext(text);
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

function keywordOverlap(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const w of setA) {
    if (setB.has(w)) shared++;
  }
  return shared / Math.min(setA.size, setB.size);
}

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
        const field = contradiction.field || "info";
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
