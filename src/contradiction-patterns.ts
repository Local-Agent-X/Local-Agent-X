/**
 * Local Agent X — Contradiction Patterns
 *
 * Pure pattern-matching layer for the contradiction detector: shared types,
 * the fact/field keyword patterns, and the entity/tokenize/overlap helpers.
 * No persistence or state — the stateful detector lives in
 * contradiction-detector.ts.
 */

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

// Cheap surface markers that a message asserts a fact about the user worth
// checking against their accumulated record. The precise comparison lives in
// checkContradiction() against FIELD_PATTERNS.
export const FACT_PATTERNS = [
  /\bi (am|work|live|use|prefer|like|hate|love|have|need|want)\b/i,
  /\bmy (name|job|project|favorite|preference|dog|cat|wife|husband|kid)\b/i,
  /\bi('m| am) (a |an )?[a-z]+ (developer|engineer|designer|manager|student)/i,
  /\bi (moved|switched|changed|started|quit|joined)\b/i,
];

// ── Keyword patterns for contradiction categories ────────

export interface FieldPattern {
  field: string;
  patterns: RegExp[];
  /** Extract the value portion from a matching fact */
  extractValue: (text: string) => string | null;
}

export const FIELD_PATTERNS: FieldPattern[] = [
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

export function getEntity(text: string): string | null {
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

export function keywordOverlap(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const w of setA) {
    if (setB.has(w)) shared++;
  }
  return shared / Math.min(setA.size, setB.size);
}
